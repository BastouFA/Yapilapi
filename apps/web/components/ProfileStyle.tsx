'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Avatar, Button, Card, Checkbox, Icon, TextField } from '@yapilapi/design-system';
import {
  CITY_MAX,
  MAX_FEATURED_POSTS,
  MAX_PROFILE_LINKS,
  PROFILE_ACCENTS,
  PROFILE_HEADER_STYLES,
  PROFILE_LINK_LABEL_MAX,
  PROFILE_TABS,
  PRONOUNS_MAX,
  THEME_SURFACES,
  linkHost,
  profileAccentColors,
  type MessageKey,
  type MusicTrack,
  type Post,
  type PostMusic,
  type Profile,
  type ProfileAccent,
  type ProfileHeaderStyle,
  type ProfileLink,
  type ProfileTab,
  type ThemeName,
} from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useSession } from '@/app/providers';
import { MusicField, draftMusic, musicInput, type DraftMusic } from '@/components/MusicPicker';
import { musicHref, useMusicCredit, useMusicLoop } from '@/components/StoryMusic';

// ── Accent ──────────────────────────────────────────────────────────────
/**
 * CSS custom properties for an accent in both themes. `.profile-accent` (globals.css) picks the
 * light or dark set, so everything inside (buttons, tabs, links, the header gradient) takes the
 * accent, already adjusted for AA contrast by profileAccentColors.
 */
export function accentVars(accent: ProfileAccent): CSSProperties {
  const out: Record<string, string> = {};
  for (const [theme, suffix] of [
    ['light', 'l'],
    ['dark', 'd'],
  ] as const) {
    const c = profileAccentColors(accent, theme);
    out[`--pa-accent-${suffix}`] = c.accent;
    out[`--pa-strong-${suffix}`] = c.accentStrong;
    out[`--pa-on-${suffix}`] = c.onAccent;
    out[`--pa-soft-${suffix}`] = c.soft;
    out[`--pa-end-${suffix}`] = c.gradEnd;
  }
  return out as CSSProperties;
}

/** Wraps a profile so its buttons, tabs and links use the person's accent. */
export function AccentScope({ accent, children, className }: { accent: ProfileAccent; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `profile-accent ${className}` : 'profile-accent'} style={accentVars(accent)}>
      {children}
    </div>
  );
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
  mixes: 'mixes.tab',
};
export const tabLabel = (tab: ProfileTab): MessageKey => TAB_LABELS[tab];

// ── On the profile ──────────────────────────────────────────────────────
/** Pronouns next to the name, as a quiet label. */
export function Pronouns({ value }: { value: string }) {
  const { t } = useSession();
  return (
    <span className="profile__pronouns">
      <span className="yp-visually-hidden">{`${t('ps.pronouns')}: `}</span>
      <bdi>{value}</bdi>
    </span>
  );
}

/** City and when they joined. */
export function ProfileAbout({ profile }: { profile: Profile }) {
  const { t, locale } = useSession();
  const joined = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(profile.joinedAt));
  return (
    <section className="profile__about" aria-label={t('ps.about')}>
      {profile.city ? (
        <span className="profile__about-item">
          <Icon name="map-pin" size={16} />
          <span className="yp-visually-hidden">{`${t('ps.city')}: `}</span>
          <bdi>{profile.city}</bdi>
        </span>
      ) : null}
      <span className="profile__about-item">
        <Icon name="calendar" size={16} />
        {t('ps.joined', { date: joined })}
      </span>
    </section>
  );
}

/** Profile links as tidy buttons: the site's icon (fetched and checked by the server) or a generic one, the title and the site. */
export function ProfileLinks({ links }: { links: ProfileLink[] }) {
  const { t } = useSession();
  if (!links.length) return null;
  return (
    <ul className="profile-links" aria-label={t('ps.links.title')}>
      {links.map((l, i) => {
        const host = linkHost(l.url) ?? '';
        return (
          <li key={`${l.url}-${i}`}>
            <a className="profile-link" href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">
              <span className={l.iconUrl ? 'profile-link__icon profile-link__icon--site' : 'profile-link__icon'} aria-hidden>
                {l.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={l.iconUrl} alt="" width={20} height={20} loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <Icon name="link" size={16} />
                )}
              </span>
              <span className="profile-link__text">
                <bdi className="profile-link__label">{l.label}</bdi>
                <bdi className="profile-link__host">{host}</bdi>
              </span>
              <span className="yp-visually-hidden">{` ${t('ps.links.opensNew')}`}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The profile song: a small chip with a play button. Nothing loads or plays until it is pressed
 * (so it never autoplays and costs no data before), and with Data saver the cover art isn't shown.
 * A song that can't play here says why, quietly.
 */
export function ProfileSongChip({ song }: { song: PostMusic }) {
  const { t, dataSaver } = useSession();
  const credit = useMusicCredit();
  const [playing, setPlaying] = useState(false);
  useMusicLoop(song.audioUrl ? { sound: { audioUrl: song.audioUrl }, startMs: song.startMs, durationMs: song.durationMs } : null, playing);
  const names = { title: song.title, artist: song.artist };
  return (
    <div className="profile-song">
      <div className={playing ? 'profile-song__chip profile-song__chip--playing' : 'profile-song__chip'}>
        {song.audioUrl ? (
          <button
            type="button"
            className="profile-song__play"
            aria-label={playing ? t('music.pauseOn', names) : t('music.playOn', names)}
            onClick={() => setPlaying((p) => !p)}
          >
            <Icon name={playing ? 'pause' : 'play'} size={14} filled />
          </button>
        ) : (
          <span className="profile-song__play profile-song__play--off" aria-hidden>
            <Icon name="volume-off" size={14} />
          </span>
        )}
        {song.coverUrl && !dataSaver.active ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="profile-song__cover" src={song.coverUrl} alt="" width={24} height={24} loading="lazy" />
        ) : null}
        <Link href={musicHref(song)} className="profile-song__name" aria-label={t('music.open', { title: song.title })}>
          <span className="yp-visually-hidden">{`${t('ps.song.title')}: `}</span>
          <bdi className="profile-song__title">{song.title}</bdi>
          <bdi className="profile-song__artist">{song.artist}</bdi>
        </Link>
        {playing ? (
          <span className="profile-song__bars" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : null}
      </div>
      <p className="profile-song__credit">{song.unavailable ? t(`music.unavailable.${song.unavailable}` as MessageKey) : credit(song)}</p>
    </div>
  );
}

/** A small picture for a post: its first photo (small size), a reel's poster, or its first words. */
function PostThumb({ post, saver, small }: { post: Post; saver: boolean; small?: boolean }) {
  const m = post.media[0];
  const src = m
    ? m.kind === 'image'
      ? (m.variants?.thumb ?? m.variants?.medium ?? (saver ? null : m.url))
      : (m.posterUrl ?? m.variants?.thumb ?? null)
    : null;
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className="featured__img" src={src} alt={m?.altText ?? ''} loading="lazy" />
  ) : small ? (
    <Icon name="edit" size={18} />
  ) : (
    <span className="featured__text">
      <bdi>{post.body.slice(0, 120)}</bdi>
    </span>
  );
}

/** Up to 3 posts or reels the person chose, shown first. */
export function FeaturedRow({ posts }: { posts: Post[] }) {
  const { t, dataSaver } = useSession();
  if (!posts.length) return null;
  return (
    <section className="featured" aria-labelledby="featured-title">
      <h2 id="featured-title" className="section-title" style={{ margin: 0 }}>
        {t('ps.featured.title')}
      </h2>
      <ul className="featured__row">
        {posts.map((p) => (
          <li key={p.id}>
            <Link
              href={p.format === 'reel' ? `/reels?start=${p.id}` : `/p/${p.id}`}
              className="featured__item"
              aria-label={`${p.format === 'reel' ? t('m.title.reels') : t('profile.posts')}: ${p.body.slice(0, 80) || t('ps.featured.untitled')}`}
            >
              <PostThumb post={p} saver={dataSaver.active} />
              {p.format === 'reel' ? (
                <span className="featured__badge" aria-hidden>
                  <Icon name="play" size={12} filled />
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Live preview ────────────────────────────────────────────────────────
/**
 * A small drawing of the profile's top in one theme, with the chosen accent and header style,
 * drawn with the same contrast-checked colours the profile uses.
 */
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
  const { t } = useSession();
  const c = profileAccentColors(accent, theme);
  const s = THEME_SURFACES[theme];
  const muted = theme === 'dark' ? '#9AA0BC' : '#555B75';
  const photo = header === 'cover' && profile.coverUrl;
  return (
    <figure className="style-preview" style={{ background: s.ground, color: s.ink, borderColor: theme === 'dark' ? '#262A40' : '#E3E5EF' }}>
      {header === 'clean' ? null : (
        <div
          className="style-preview__band"
          style={
            photo
              ? { backgroundImage: `url("${profile.coverUrl}")`, backgroundSize: 'cover', backgroundPosition: 'center', height: 'auto', aspectRatio: '8 / 3' }
              : { background: `linear-gradient(135deg, ${c.accentStrong}, ${c.accent} 50%, ${c.gradEnd})` }
          }
        />
      )}
      <div className="style-preview__body" style={{ background: s.surface }}>
        <Avatar name={profile.displayName} src={profile.avatarUrl} size="sm" />
        <div className="style-preview__name">
          <bdi style={{ fontWeight: 700 }}>{profile.displayName}</bdi>
          {pronouns.trim() ? <bdi style={{ color: muted, fontSize: 12 }}>{pronouns.trim()}</bdi> : null}
        </div>
        <span
          className="style-preview__button"
          style={{ background: `linear-gradient(120deg, ${c.accent}, ${c.accentStrong} 50%, ${c.gradEnd})`, color: c.onAccent }}
        >
          {t('profile.follow')}
        </span>
        <span className="style-preview__tabs">
          <span style={{ color: c.accent, borderBottomColor: c.accent }}>{t('profile.posts')}</span>
          <span style={{ color: muted }}>{t('m.title.reels')}</span>
        </span>
        <span className="style-preview__chip" style={{ background: c.soft, color: c.accentStrong }}>
          <Icon name="link" size={12} />
          {t('ps.links.title')}
        </span>
      </div>
      <figcaption className="style-preview__caption" style={{ color: muted }}>
        {t(theme === 'dark' ? 'st.appearance.dark' : 'st.appearance.light')}
      </figcaption>
    </figure>
  );
}

// ── Editor ──────────────────────────────────────────────────────────────
/** A song on the profile as a picker track, so the music field can show and change it. */
function songAsTrack(m: PostMusic): MusicTrack {
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

const HEADER_LABELS: Record<ProfileHeaderStyle, MessageKey> = { cover: 'ps.header.cover', gradient: 'ps.header.gradient', clean: 'ps.header.clean' };

/**
 * "Customise your profile" in Settings > Account: accent and header with a live preview in both
 * themes, pronouns and city, links, a song, which tabs show and their order, and featured posts.
 */
export function ProfileCustomizeCard() {
  const { me, t, toast } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [accent, setAccent] = useState<ProfileAccent>('yapi');
  const [header, setHeader] = useState<ProfileHeaderStyle>('cover');
  const [pronouns, setPronouns] = useState('');
  const [city, setCity] = useState('');
  const [links, setLinks] = useState<{ label: string; url: string }[]>([]);
  const [order, setOrder] = useState<ProfileTab[]>([...PROFILE_TABS]);
  const [shown, setShown] = useState<Set<ProfileTab>>(new Set(PROFILE_TABS));
  const [featured, setFeatured] = useState<Post[]>([]);
  const [song, setSong] = useState<DraftMusic | null>(null);
  const [songChanged, setSongChanged] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const linkList = useRef<HTMLOListElement>(null);
  const addLink = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!me) return;
    api.users.get(me.username).then(
      ({ profile: p }) => {
        setProfile(p);
        setAccent(p.style.accent);
        setHeader(p.style.header);
        setPronouns(p.pronouns ?? '');
        setCity(p.city ?? '');
        setLinks(p.links.map(({ label, url }) => ({ label, url })));
        setOrder([...p.tabs, ...PROFILE_TABS.filter((x) => !p.tabs.includes(x))]);
        setShown(new Set(p.tabs));
        setFeatured(p.featured);
        setSong(p.song ? draftMusic(songAsTrack(p.song), 'post', { startMs: p.song.startMs, durationMs: p.song.durationMs }) : null);
        setSongChanged(false);
      },
      () => {},
    );
  }, [me]);

  if (!me || !profile) return null;

  const move = (i: number, by: -1 | 1) =>
    setOrder((o) => {
      const j = i + by;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j]!, next[i]!];
      setStatus(t('ps.tabs.moved', { tab: t(TAB_LABELS[next[j]!]), position: j + 1 }));
      return next;
    });

  async function save() {
    setBusy(true);
    setFields({});
    try {
      const body: Record<string, unknown> = {
        accent,
        headerStyle: header,
        pronouns: pronouns.trim() || null,
        city: city.trim() || null,
        links: links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })).filter((l) => l.label || l.url),
        tabs: order.filter((x) => shown.has(x)),
        featuredPostIds: featured.map((p) => p.id),
      };
      if (songChanged) body.song = song ? musicInput(song) : null;
      const r = await api.me.updateProfile(body);
      setProfile(r.profile);
      setFeatured(r.profile.featured);
      setSongChanged(false);
      toast(t('ps.saved'));
    } catch (e) {
      toast(errorMessage(e));
      setFields(fieldErrors(e));
    } finally {
      setBusy(false);
    }
  }

  const accentName = (id: ProfileAccent) => t(`ps.accent.${id}` as MessageKey);

  return (
    <Card title={t('ps.edit.title')} subtitle={t('ps.edit.desc')}>
      <div className="stack customize">
        {/* Style, with a live preview in both themes */}
        <section className="stack-sm" aria-labelledby="ps-style">
          <h3 id="ps-style" className="customize__heading">
            {t('ps.style.title')}
          </h3>
          <div className="style-previews" aria-hidden>
            <Preview theme="light" accent={accent} header={header} profile={profile} pronouns={pronouns} />
            <Preview theme="dark" accent={accent} header={header} profile={profile} pronouns={pronouns} />
          </div>
          <fieldset className="accent-picker">
            <legend className="yp-field__label">{t('ps.accent.label')}</legend>
            {PROFILE_ACCENTS.map((a) => (
              <label key={a.id} className="accent-picker__swatch" title={accentName(a.id)}>
                <input type="radio" name="profile-accent" className="yp-visually-hidden" checked={accent === a.id} onChange={() => setAccent(a.id)} />
                <span
                  aria-hidden
                  className="accent-picker__dot"
                  style={{
                    background: `linear-gradient(135deg, ${profileAccentColors(a.id, 'light').accent} 50%, ${profileAccentColors(a.id, 'dark').accent} 50%)`,
                  }}
                >
                  {accent === a.id ? <Icon name="check" size={16} /> : null}
                </span>
                <span className="yp-visually-hidden">{accentName(a.id)}</span>
              </label>
            ))}
            <p className="yp-field__hint" style={{ margin: 0, flexBasis: '100%' }}>
              {t('ps.accent.hint', { name: accentName(accent) })}
            </p>
          </fieldset>
          <fieldset className="header-picker">
            <legend className="yp-field__label">{t('ps.header.label')}</legend>
            {/* Toggle buttons like Segments (a radio can't also be "pressed"); the fieldset names the group. */}
            <div className="yp-segments">
              {PROFILE_HEADER_STYLES.map((h) => (
                <button key={h} type="button" aria-pressed={header === h} onClick={() => setHeader(h)}>
                  {t(HEADER_LABELS[h])}
                </button>
              ))}
            </div>
            <p className="yp-field__hint" style={{ margin: 0 }}>
              {t(header === 'cover' ? 'ps.header.coverHint' : header === 'gradient' ? 'ps.header.gradientHint' : 'ps.header.cleanHint')}
            </p>
          </fieldset>
        </section>

        {/* About */}
        <section className="stack-sm" aria-labelledby="ps-about">
          <h3 id="ps-about" className="customize__heading">
            {t('ps.about')}
          </h3>
          <div className="customize__pair">
            <TextField
              label={t('ps.pronouns')}
              hint={t('ps.pronouns.hint')}
              value={pronouns}
              maxLength={PRONOUNS_MAX}
              error={fields.pronouns}
              onChange={(e) => setPronouns(e.currentTarget.value)}
            />
            <TextField
              label={t('ps.city')}
              hint={t('ps.city.hint')}
              value={city}
              maxLength={CITY_MAX}
              error={fields.city}
              autoComplete="address-level2"
              onChange={(e) => setCity(e.currentTarget.value)}
            />
          </div>
        </section>

        {/* Links */}
        <section className="stack-sm" aria-labelledby="ps-links">
          <h3 id="ps-links" className="customize__heading">
            {t('ps.links.title')}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {t('ps.links.hint', { max: MAX_PROFILE_LINKS })}
          </p>
          <ol className="link-editor" ref={linkList}>
            {links.map((l, i) => (
              <li key={i} className="link-editor__row">
                <TextField
                  label={t('ps.links.label', { n: i + 1 })}
                  value={l.label}
                  maxLength={PROFILE_LINK_LABEL_MAX}
                  error={fields[`links.${i}.label`]}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setLinks((ls) => ls.map((x, j) => (j === i ? { ...x, label: v } : x)));
                  }}
                />
                <TextField
                  label={t('ps.links.url', { n: i + 1 })}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  dir="ltr"
                  value={l.url}
                  maxLength={500}
                  error={fields[`links.${i}.url`]}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setLinks((ls) => ls.map((x, j) => (j === i ? { ...x, url: v } : x)));
                  }}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={t('ps.links.remove', { n: i + 1 })}
                  onClick={() => {
                    setLinks((ls) => ls.filter((_, j) => j !== i));
                    // The button goes with its row: focus moves to "Add a link".
                    requestAnimationFrame(() => addLink.current?.focus());
                  }}
                />
              </li>
            ))}
          </ol>
          {fields.links ? <span className="yp-field__error">{fields.links}</span> : null}
          <div className="row">
            <Button
              size="sm"
              variant="secondary"
              icon="plus"
              ref={addLink}
              disabled={links.length >= MAX_PROFILE_LINKS}
              onClick={() => {
                setLinks((ls) => [...ls, { label: '', url: '' }]);
                // Straight to the new link's name.
                requestAnimationFrame(() => linkList.current?.querySelector<HTMLInputElement>('li:last-child input')?.focus());
              }}
            >
              {t('ps.links.add')}
            </Button>
          </div>
        </section>

        {/* Song */}
        <section className="stack-sm" aria-labelledby="ps-song">
          <h3 id="ps-song" className="customize__heading">
            {t('ps.song.title')}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {t('ps.song.hint')}
          </p>
          <MusicField
            use="post"
            value={song}
            onChange={(m) => {
              setSong(m);
              setSongChanged(true);
            }}
          />
          {fields['song.durationMs'] || fields.song ? <span className="yp-field__error">{fields['song.durationMs'] ?? fields.song}</span> : null}
        </section>

        {/* Tabs */}
        <section className="stack-sm" aria-labelledby="ps-tabs">
          <h3 id="ps-tabs" className="customize__heading">
            {t('ps.tabs.title')}
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: 14 }}>
            {t('ps.tabs.hint')}
          </p>
          <ol className="tab-editor">
            {order.map((tab, i) => {
              const label = t(TAB_LABELS[tab]);
              const on = shown.has(tab);
              const last = on && shown.size === 1;
              return (
                <li key={tab} className="tab-editor__row">
                  <Checkbox
                    label={label}
                    checked={on}
                    disabled={last}
                    description={last ? t('ps.tabs.lastOne') : undefined}
                    onChange={(e) => {
                      const next = new Set(shown);
                      if (e.currentTarget.checked) next.add(tab);
                      else next.delete(tab);
                      setShown(next);
                    }}
                  />
                  <span className="tab-editor__moves">
                    <button
                      type="button"
                      className="tab-editor__move tab-editor__move--up"
                      aria-label={t('ps.tabs.up', { tab: label })}
                      disabled={i === 0}
                      onClick={() => move(i, -1)}
                    >
                      <Icon name="chevron-down" size={16} />
                    </button>
                    <button
                      type="button"
                      className="tab-editor__move"
                      aria-label={t('ps.tabs.down', { tab: label })}
                      disabled={i === order.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <Icon name="chevron-down" size={16} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
          <p className="yp-visually-hidden" role="status">
            {status}
          </p>
        </section>

        {/* Featured */}
        <FeaturedPicker username={me.username} value={featured} onChange={setFeatured} error={fields.featuredPostIds} />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Button loading={busy} onClick={save}>
            {t('ps.save')}
          </Button>
          <Link href={`/u/${me.username}`} className="muted">
            {t('ps.viewProfile')}
          </Link>
        </div>
      </div>
    </Card>
  );
}

/** Choose up to 3 of your own posts or reels (that other people can see) to show first. */
function FeaturedPicker({ username, value, onChange, error }: { username: string; value: Post[]; onChange: (p: Post[]) => void; error?: string }) {
  const { t, dataSaver } = useSession();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Post[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => {
    if (!open || items) return;
    api.users.posts(username).then(
      (r) => {
        setItems(r.items);
        setCursor(r.nextCursor);
      },
      () => setItems([]),
    );
  }, [open, items, username]);
  const chosen = useMemo(() => new Set(value.map((p) => p.id)), [value]);
  const pickButton = useRef<HTMLButtonElement>(null);
  // Only posts other people can see, and not ones in a community.
  const choosable = (items ?? []).filter((p) => p.visibility !== 'private' && !p.community && !p.status);

  return (
    <section className="stack-sm" aria-labelledby="ps-featured">
      <h3 id="ps-featured" className="customize__heading">
        {t('ps.featured.title')}
      </h3>
      <p className="muted" style={{ margin: 0, fontSize: 14 }}>
        {t('ps.featured.hint', { max: MAX_FEATURED_POSTS })}
      </p>
      {value.length ? (
        <ol className="featured-editor">
          {value.map((p, i) => (
            <li key={p.id} className="featured-editor__item">
              <span className="featured__item featured__item--small">
                <PostThumb post={p} saver={dataSaver.active} small />
              </span>
              <span className="featured-editor__text">
                <bdi>{p.body.slice(0, 60) || t('ps.featured.untitled')}</bdi>
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon="x"
                aria-label={t('ps.featured.remove', { n: i + 1 })}
                onClick={() => {
                  onChange(value.filter((x) => x.id !== p.id));
                  requestAnimationFrame(() => pickButton.current?.focus());
                }}
              />
            </li>
          ))}
        </ol>
      ) : (
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>
          {t('ps.featured.none')}
        </p>
      )}
      {error ? <span className="yp-field__error">{error}</span> : null}
      <div className="row">
        <Button ref={pickButton} size="sm" variant="secondary" icon={open ? 'chevron-down' : 'plus'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? t('ps.featured.done') : t('ps.featured.pick')}
        </Button>
      </div>
      {open ? (
        items === null ? (
          <p className="muted">{t('common.loading')}</p>
        ) : choosable.length ? (
          <div className="stack-sm">
            <ul className="featured-grid">
              {choosable.map((p) => {
                const on = chosen.has(p.id);
                const full = !on && value.length >= MAX_FEATURED_POSTS;
                return (
                  <li key={p.id}>
                    <label className={on ? 'featured-grid__item featured-grid__item--on' : 'featured-grid__item'}>
                      <input
                        type="checkbox"
                        className="yp-visually-hidden"
                        checked={on}
                        disabled={full}
                        onChange={() => onChange(on ? value.filter((x) => x.id !== p.id) : [...value, p])}
                      />
                      <PostThumb post={p} saver={dataSaver.active} />
                      <span className="yp-visually-hidden">{p.body.slice(0, 80) || t('ps.featured.untitled')}</span>
                      {on ? (
                        <span className="featured-grid__check" aria-hidden>
                          {value.findIndex((x) => x.id === p.id) + 1}
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
            {value.length >= MAX_FEATURED_POSTS ? (
              <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>
                {t('ps.featured.max', { max: MAX_FEATURED_POSTS })}
              </p>
            ) : null}
            {cursor ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  const r = await api.users.posts(username, cursor);
                  setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !(cur ?? []).some((y) => y.id === x.id))]);
                  setCursor(r.nextCursor);
                }}
              >
                {t('ps.featured.more')}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="muted">{t('ps.featured.nothing')}</p>
        )
      ) : null}
    </section>
  );
}
