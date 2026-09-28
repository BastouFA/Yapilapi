'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Avatar, Button, EmptyState, Icon, Skeleton } from '@yapilapi/design-system';
import type { OnThisDayCard, PluralKey, Post, PulseCards as PulseCardsData, WeeklyWrap, WeeklyWrapCard, WeeklyWrapCounts } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { postThumb } from '@/components/WatchTogether';

/**
 * The weekly wrap (a private look back at your week) and "On this day": the gentle cards at the
 * top of Pulse, the list of past weeks and one week's wrap with its shareable card.
 */

const STATS: { key: keyof WeeklyWrapCounts; label: PluralKey }[] = [
  { key: 'posts', label: 'wrap.stat.posts' },
  { key: 'reels', label: 'wrap.stat.reels' },
  { key: 'newFriends', label: 'wrap.stat.friends' },
  { key: 'communities', label: 'wrap.stat.communities' },
  { key: 'places', label: 'wrap.stat.places' },
  { key: 'events', label: 'wrap.stat.events' },
  { key: 'songs', label: 'wrap.stat.songs' },
];

/** A YYYY-MM-DD date in your language (read as UTC, so it never shifts a day). */
export function wrapDate(date: string, locale: string, long = false): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: 'numeric', month: long ? 'long' : 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
  } catch {
    return date;
  }
}

/** The week's counts that aren't zero: the number, then what it counts. */
export function WrapStats({ counts }: { counts: WeeklyWrapCounts }) {
  const { tp, locale } = useSession();
  const shown = STATS.filter((s) => counts[s.key] > 0);
  if (!shown.length) return null;
  const n = new Intl.NumberFormat(locale);
  return (
    <ul className="wrap-stats">
      {shown.map((s) => (
        <li key={s.key}>
          <strong>{n.format(counts[s.key])}</strong> <span>{tp(s.label, counts[s.key])}</span>
        </li>
      ))}
    </ul>
  );
}

// ── Pulse ────────────────────────────────────────────────────────────────

const OTD_KEY = 'yp.otd.dismissed';
/** Today on this device, as YYYY-MM-DD. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function otdDismissedToday(): boolean {
  try {
    return localStorage.getItem(OTD_KEY) === today();
  } catch {
    return false;
  }
}
function dismissOtdToday() {
  try {
    localStorage.setItem(OTD_KEY, today());
  } catch {
    /* private mode: hidden for this visit only */
  }
}

/** Putting a card away removes the button that had focus: focus goes to the page's title instead of nowhere. */
function focusPageTitle() {
  const h1 = document.querySelector<HTMLElement>('main h1');
  if (!h1) return;
  if (!h1.hasAttribute('tabindex')) h1.tabIndex = -1;
  h1.focus();
}

/**
 * The top of Pulse: this week's wrap (for a few days after Sunday, until put away) and "On this
 * day" (your own posts from this day in earlier years, hidden for the day on this device).
 */
export function PulseCards() {
  const { t, tp, locale, toast } = useSession();
  const [cards, setCards] = useState<PulseCardsData | null>(null);
  const [otdHidden, setOtdHidden] = useState(true);

  useEffect(() => {
    setOtdHidden(otdDismissedToday());
    let live = true;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api.wraps.pulseCards(tz || undefined).then(
      (r) => live && setCards(r),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);

  if (!cards) return null;
  const wrap = cards.wrap;
  const otd = otdHidden ? null : cards.onThisDay;
  if (!wrap && !otd) return null;

  return (
    <div className="pulse-cards">
      {wrap ? (
        <WrapPulseCard
          card={wrap}
          onDismiss={async () => {
            setCards((c) => (c ? { ...c, wrap: null } : c));
            requestAnimationFrame(focusPageTitle);
            try {
              await api.wraps.dismiss(wrap.id);
            } catch (e) {
              toast(errorMessage(e));
            }
          }}
        />
      ) : null}
      {otd ? (
        <OnThisDay
          card={otd}
          t={t}
          tp={tp}
          locale={locale}
          onDismiss={() => {
            dismissOtdToday();
            setOtdHidden(true);
            requestAnimationFrame(focusPageTitle);
          }}
        />
      ) : null}
    </div>
  );
}

function WrapPulseCard({ card, onDismiss }: { card: WeeklyWrapCard; onDismiss: () => void }) {
  const { t, locale } = useSession();
  return (
    <section className="pulse-card" aria-labelledby={`pulse-wrap-${card.id}`}>
      <span className="pulse-card__thumb">{card.thumbUrl ? <img src={card.thumbUrl} alt="" loading="lazy" /> : <Icon name="sparkle" size={24} />}</span>
      <div className="pulse-card__body">
        <h2 id={`pulse-wrap-${card.id}`} className="pulse-card__title">
          {t('wrap.cardTitle')}
        </h2>
        <p className="muted pulse-card__text">{t('wrap.cardBody', { start: wrapDate(card.weekStart, locale), end: wrapDate(card.weekEnd, locale) })}</p>
        <WrapStats counts={card.counts} />
        <div className="pulse-card__actions">
          <Link href={`/wraps/${card.id}`} className="yp-btn yp-btn--primary yp-btn--sm">
            {t('wrap.open')}
          </Link>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('wrap.dismiss')}
          </Button>
        </div>
      </div>
    </section>
  );
}

function OnThisDay({
  card,
  t,
  tp,
  locale,
  onDismiss,
}: {
  card: OnThisDayCard;
  t: ReturnType<typeof useSession>['t'];
  tp: ReturnType<typeof useSession>['tp'];
  locale: string;
  onDismiss: () => void;
}) {
  let years = card.years.join(', ');
  try {
    years = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(card.years.map(String));
  } catch {
    /* older browsers: a plain list */
  }
  const thumbs = card.posts
    .map((p) => ({ id: p.id, src: postThumb(p), sensitive: p.media.some((m) => m.sensitive) }))
    .filter((x) => x.src)
    .slice(0, 3);
  return (
    <section className="pulse-card" aria-labelledby="pulse-otd">
      <span className="pulse-card__thumb">
        <Icon name="calendar" size={24} />
      </span>
      <div className="pulse-card__body">
        <h2 id="pulse-otd" className="pulse-card__title">
          {t('otd.title')}
        </h2>
        <p className="muted pulse-card__text">
          {tp('otd.body', card.count)} {card.years.length ? t('otd.years', { years }) : null}
        </p>
        {thumbs.length ? (
          <div className="pulse-card__thumbs" aria-hidden>
            {thumbs.map((x) => (
              <img key={x.id} src={x.src!} alt="" loading="lazy" className={x.sensitive ? 'yp-blurred' : undefined} />
            ))}
          </div>
        ) : null}
        <div className="pulse-card__actions">
          <Link href="/memories" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('otd.open')}
          </Link>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            {t('otd.dismiss')}
          </Button>
        </div>
      </div>
    </section>
  );
}

// ── Past weeks ───────────────────────────────────────────────────────────

/** Your weekly wraps, newest first. */
export function WrapList() {
  const { t, locale, toast } = useSession();
  const [items, setItems] = useState<WeeklyWrapCard[] | null>(null);
  useEffect(() => {
    api.wraps.list().then(
      (r) => setItems(r.items),
      (e) => {
        setItems([]);
        toast(errorMessage(e));
      },
    );
  }, [toast]);
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('wrap.past')}</h1>
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('wrap.settings.desc')}
      </p>
      {items === null ? (
        <Skeleton height={200} />
      ) : items.length ? (
        <ul className="wrap-list">
          {items.map((w) => (
            <li key={w.id}>
              <Link href={`/wraps/${w.id}`} className="wrap-row">
                <span className="wrap-row__thumb">{w.thumbUrl ? <img src={w.thumbUrl} alt="" loading="lazy" /> : <Icon name="sparkle" size={20} />}</span>
                <span className="wrap-row__text">
                  <strong>{t('wrap.dates', { start: wrapDate(w.weekStart, locale), end: wrapDate(w.weekEnd, locale) })}</strong>
                  <WrapStats counts={w.counts} />
                </span>
                <Icon name="chevron-right" size={18} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t('wrap.none')} />
      )}
    </div>
  );
}

// ── One week ─────────────────────────────────────────────────────────────

const postHref = (p: Post) => (p.format === 'reel' ? `/reels?start=${p.id}` : `/p/${p.id}`);

/** A post, small: its picture and the start of its text. */
function PostTile({ post }: { post: Post }) {
  const { locale } = useSession();
  const thumb = postThumb(post);
  return (
    <Link href={postHref(post)} className="wrap-post">
      <span className="wrap-post__thumb">
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" className={post.media.some((m) => m.sensitive) ? 'yp-blurred' : undefined} />
        ) : (
          <Icon name="message" size={20} />
        )}
      </span>
      <span className="wrap-post__text">
        {post.body ? (
          <span className="wrap-post__caption" dir="auto">
            {post.body}
          </span>
        ) : null}
        <span className="muted wrap-post__date">
          {new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'short' }).format(new Date(post.createdAt))}
        </span>
      </span>
    </Link>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section className="wrap-section" aria-labelledby={`wrap-${id}`}>
      <h2 id={`wrap-${id}`} className="section-title">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** One week's wrap: its card (to share or save), the moment of the week, best moments, and what else happened. */
export function WrapView({ id }: { id: string }) {
  const { t, tp, locale, toast } = useSession();
  const router = useRouter();
  const [wrap, setWrap] = useState<WeeklyWrap | null>(null);
  const [missing, setMissing] = useState(false);
  const [card, setCard] = useState<File | null>(null);
  const [busy, setBusy] = useState<'share' | 'delete' | null>(null);

  useEffect(() => {
    let live = true;
    setWrap(null);
    setMissing(false);
    api.wraps.get(id).then(
      (r) => live && setWrap(r.wrap),
      (e) => {
        if (!live) return;
        setMissing(true);
        if (!(e instanceof ApiError && e.status === 404)) toast(errorMessage(e));
      },
    );
    return () => {
      live = false;
    };
  }, [id, toast]);

  // Where the system can share files, have the card ready so sharing happens right on the press.
  const loaded = !!wrap;
  useEffect(() => {
    if (!loaded || typeof navigator === 'undefined' || typeof navigator.canShare !== 'function') return;
    let live = true;
    api.wraps.cardImage(id).then(
      (blob) => live && setCard(new File([blob], 'yapilapi-week.png', { type: 'image/png' })),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [loaded, id]);

  if (missing)
    return (
      <div className="yp-shell__inner">
        <EmptyState
          title={t('wrap.notFound')}
          action={
            <Link href="/wraps" className="yp-btn yp-btn--secondary">
              {t('wrap.past')}
            </Link>
          }
        />
      </div>
    );
  if (!wrap)
    return (
      <div className="yp-shell__inner" aria-busy>
        <Skeleton height={48} />
        <Skeleton height={420} />
      </div>
    );

  const cardUrl = api.wraps.cardUrl(wrap.id);
  const start = wrapDate(wrap.weekStart, locale, true);
  const end = wrapDate(wrap.weekEnd, locale, true);

  const download = (file?: Blob) => {
    const a = document.createElement('a');
    const url = file ? URL.createObjectURL(file) : cardUrl;
    a.href = url;
    a.download = 'yapilapi-week.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (file) setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  async function share() {
    // The system share sheet with the image where it takes files; otherwise the card is saved.
    if (card && navigator.canShare?.({ files: [card] })) {
      try {
        await navigator.share({ files: [card], title: t('wrap.title') });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast(errorMessage(e));
      }
      return;
    }
    setBusy('share');
    try {
      download(await api.wraps.cardImage(id));
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!confirm(t('wrap.deleteConfirm'))) return;
    setBusy('delete');
    try {
      await api.wraps.remove(id);
      toast(t('wrap.deleted'));
      router.push('/wraps');
    } catch (e) {
      toast(errorMessage(e));
      setBusy(null);
    }
  }

  return (
    <div className="yp-shell__inner wrap-page">
      <div className="yp-topbar">
        <div className="row" style={{ minWidth: 0 }}>
          <Link href="/wraps" className="yp-action" aria-label={t('wrap.past')}>
            <Icon name="arrow-left" />
          </Link>
          <div style={{ minWidth: 0 }}>
            <h1>{t('wrap.title')}</h1>
            <p className="muted wrap-page__dates">{t('wrap.dates', { start, end })}</p>
          </div>
        </div>
      </div>
      <p className="wrap-page__private">
        <Icon name="lock" size={16} /> {t('wrap.private')}
      </p>

      <figure className="wrap-card">
        <img src={cardUrl} alt={t('wrap.cardAlt')} width={1080} height={1350} />
      </figure>
      <div className="row wrap-card__actions">
        <Button icon="send" onClick={() => void share()} loading={busy === 'share'}>
          {t('wrap.share')}
        </Button>
        <a href={cardUrl} download="yapilapi-week.png" className="yp-btn yp-btn--secondary">
          <Icon name="download" />
          {t('wrap.download')}
        </a>
      </div>

      <WrapStats counts={wrap.counts} />

      {wrap.moment ? (
        <Section id="moment" title={t('wrap.moment')}>
          <PostTile post={wrap.moment} />
        </Section>
      ) : null}
      {wrap.best.length ? (
        <Section id="best" title={t('wrap.best')}>
          <ul className="wrap-grid">
            {wrap.best.slice(0, 3).map((p) => (
              <li key={p.id}>
                <PostTile post={p} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {wrap.newFriends.length ? (
        <Section id="friends" title={t('wrap.newFriends')}>
          <ul className="wrap-people">
            {wrap.newFriends.map((u) => (
              <li key={u.id}>
                <Link href={`/u/${u.username}`} className="wrap-people__link">
                  <Avatar name={u.displayName} src={u.avatarUrl} size="md" />
                  <bdi>{u.displayName}</bdi>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {wrap.communities.length ? (
        <Section id="communities" title={t('wrap.communities')}>
          <ul className="wrap-links">
            {wrap.communities.map((c) => (
              <li key={c.id}>
                <Link href={`/c/${c.slug}`}>
                  <Icon name="users" size={18} /> <bdi>{c.name}</bdi>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {wrap.events.length ? (
        <Section id="events" title={t('wrap.events')}>
          <ul className="wrap-links">
            {wrap.events.map((e) => (
              <li key={e.id}>
                <Link href={`/events/${e.id}`}>
                  <Icon name="calendar" size={18} /> <bdi>{e.title}</bdi>
                  <span className="muted">
                    {new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(e.startsAt))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {wrap.places.length ? (
        <Section id="places" title={t('wrap.places')}>
          <ul className="wrap-links">
            {wrap.places.map((p) => (
              <li key={p.id}>
                <Link href={`/places/${p.id}`}>
                  <Icon name="map-pin" size={18} /> <bdi>{p.name}</bdi>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {wrap.songs.length ? (
        <Section id="songs" title={t('wrap.songs')}>
          <ul className="wrap-links">
            {wrap.songs.map((s) => (
              <li key={`${s.kind}-${s.id}`}>
                <Link href={s.kind === 'sound' ? `/sounds/${s.id}` : `/music/${s.id}`}>
                  <Icon name="music" size={18} />
                  <span className="wrap-song">
                    <bdi className="wrap-song__title">{s.title}</bdi>
                    {s.artist ? <bdi className="muted">{s.artist}</bdi> : null}
                  </span>
                  <span className="muted">{tp('wrap.songUses', s.uses)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <div className="row">
        <Button variant="ghost" icon="trash" loading={busy === 'delete'} onClick={() => void remove()}>
          {t('wrap.delete')}
        </Button>
      </div>
    </div>
  );
}
