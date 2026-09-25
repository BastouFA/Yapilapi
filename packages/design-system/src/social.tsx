import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { formatMoney, formatRelativeTime, t, type CaptionTrackRef, type EventItem, type MediaItem, type MessageKey, type Post } from '@yapilapi/shared';
import { Icon, type IconName } from './icons.tsx';
import { Avatar, Badge, Button, cx } from './primitives.tsx';

/** A link component (e.g. next/link). Defaults to a plain anchor. */
export type LinkLike = ComponentType<{ href: string; className?: string; children?: ReactNode; 'aria-current'?: 'page' | undefined; 'aria-label'?: string }>;
const A: LinkLike = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

// ── Navigation ──────────────────────────────────────────────────────────
export interface NavEntry {
  id: 'home' | 'discover' | 'create' | 'inbox' | 'profile';
  href: string;
  badge?: number;
}
const NAV_ICON: Record<NavEntry['id'], IconName> = { home: 'home', discover: 'compass', create: 'create', inbox: 'inbox', profile: 'user' };

/** Primary navigation: Home | Discover | Create | Inbox | Profile. Bottom bar on phones, side rail on desktop. */
export function NavBar({
  items,
  current,
  linkAs: L = A,
  locale = 'en',
  brandHref = '/home',
  logoSrc,
}: {
  items: NavEntry[];
  current?: NavEntry['id'];
  linkAs?: LinkLike;
  locale?: string;
  brandHref?: string;
  logoSrc?: string;
}) {
  return (
    <nav className="yp-nav" aria-label="Primary">
      <L href={brandHref} className="yp-nav__brand" aria-label="YAPILAPI home">
        {logoSrc ? <img src={logoSrc} alt="" /> : null}
        YAPILAPI
      </L>
      {items.map((it) => (
        <L
          key={it.id}
          href={it.href}
          className={cx('yp-nav__item', it.id === 'create' && 'yp-nav__item--create')}
          aria-current={it.id === current ? 'page' : undefined}
        >
          <span className="yp-nav__icon">
            <Icon name={NAV_ICON[it.id]} size={24} />
          </span>
          <span>{t(`nav.${it.id}` as MessageKey, locale)}</span>
          {it.badge ? <span className="yp-nav__badge">{it.badge > 99 ? '99+' : it.badge}</span> : null}
        </L>
      ))}
    </nav>
  );
}

export function Segments<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="yp-segments" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ── Media ───────────────────────────────────────────────────────────────
export function MediaGrid({ media }: { media: MediaItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!media.length) return null;
  const shown = media.slice(0, 4);
  return (
    <>
      <div className={cx('yp-media', `yp-media--${Math.min(shown.length, 4)}`)}>
        {shown.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className="yp-media__item"
            onClick={() => setOpen(i)}
            aria-label={m.altText ? `Open: ${m.altText}` : `Open media ${i + 1} of ${media.length}`}
          >
            {m.kind === 'video' ? (
              <video src={m.variants?.mp4 ?? m.url} poster={m.posterUrl ?? undefined} muted playsInline preload="metadata" />
            ) : m.kind === 'audio' ? (
              <span className="yp-media__more">♪</span>
            ) : (
              <img
                src={(shown.length > 1 ? m.variants?.medium : (m.variants?.large ?? m.variants?.medium)) ?? m.url}
                alt={m.altText ?? ''}
                loading="lazy"
                decoding="async"
                style={m.placeholder ? { backgroundImage: `url(${m.placeholder})`, backgroundSize: 'cover' } : undefined}
              />
            )}
            {i === 3 && media.length > 4 ? <span className="yp-media__more">+{media.length - 4}</span> : null}
          </button>
        ))}
      </div>
      {open !== null ? <MediaViewer media={media} index={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

/**
 * Subtitle tracks for a <video>. Caption files live on the media origin, so a
 * video that has tracks must set crossOrigin="anonymous" (see videoCrossOrigin);
 * the media route answers with CORS headers for the web app.
 */
export function CaptionTracks({ captions }: { captions?: CaptionTrackRef[] | null }) {
  return (
    <>
      {(captions ?? []).map((c) => (
        <track key={c.lang} kind="subtitles" src={c.url} srcLang={c.lang} label={c.label} />
      ))}
    </>
  );
}

/** crossOrigin for a <video>: only needed (and only set) when it has caption tracks. */
export const videoCrossOrigin = (captions?: CaptionTrackRef[] | null) => (captions?.length ? ('anonymous' as const) : undefined);

/** Full-screen media viewer: arrow keys to move, Escape to close, alt text shown. */
export function MediaViewer({ media, index, onClose }: { media: MediaItem[]; index: number; onClose: () => void }) {
  const [i, setI] = useState(index);
  const ref = useRef<HTMLDivElement>(null);
  const m = media[i]!;
  const go = useCallback((d: number) => setI((x) => (x + d + media.length) % media.length), [media.length]);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') go(1);
      if (e.key === 'ArrowLeft') go(-1);
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [go, onClose]);
  return (
    <div className="yp-viewer" role="dialog" aria-modal aria-label="Media viewer" ref={ref} tabIndex={-1}>
      <div className="yp-viewer__bar">
        <span>
          {i + 1} / {media.length}
        </span>
        <button type="button" onClick={onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </div>
      <div className="yp-viewer__stage">
        {m.kind === 'video' ? (
          <video
            key={m.id}
            src={m.variants?.mp4 ?? m.url}
            poster={m.posterUrl ?? undefined}
            crossOrigin={videoCrossOrigin(m.captions)}
            controls
            autoPlay
            playsInline
          >
            <CaptionTracks captions={m.captions} />
          </video>
        ) : m.kind === 'audio' ? (
          <audio src={m.url} controls />
        ) : (
          <img src={m.variants?.large ?? m.url} alt={m.altText ?? ''} />
        )}
      </div>
      {media.length > 1 ? (
        <>
          <button type="button" className="yp-viewer__nav yp-viewer__nav--prev" onClick={() => go(-1)} aria-label="Previous">
            <Icon name="chevron-left" />
          </button>
          <button type="button" className="yp-viewer__nav yp-viewer__nav--next" onClick={() => go(1)} aria-label="Next">
            <Icon name="chevron-right" />
          </button>
        </>
      ) : null}
      <p className="yp-viewer__alt">{m.altText ?? ''}</p>
    </div>
  );
}

// ── Menu & sheet ────────────────────────────────────────────────────────
export interface MenuAction {
  label: string;
  icon?: IconName;
  danger?: boolean;
  onSelect: () => void;
}

export function Menu({ label, actions, icon = 'more' }: { label: string; actions: MenuAction[]; icon?: IconName }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    wrap.current?.querySelector<HTMLButtonElement>('.yp-menu__item')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="yp-menu" ref={wrap}>
      <button
        type="button"
        className="yp-action"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name={icon} />
      </button>
      {open ? (
        <ul className="yp-menu__list" role="menu" id={listId}>
          {actions.map((a) => (
            <li key={a.label} role="none">
              <button
                type="button"
                role="menuitem"
                className={cx('yp-menu__item', a.danger && 'yp-menu__item--danger')}
                onClick={() => {
                  setOpen(false);
                  a.onSelect();
                }}
              >
                {a.icon ? <Icon name={a.icon} /> : null}
                {a.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Bottom sheet on phones, centered panel on larger screens. */
export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="yp-sheet__backdrop" onClick={onClose}>
      <div className="yp-sheet" role="dialog" aria-modal aria-labelledby={titleId} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="yp-sheet__grip" aria-hidden />
        <h2 className="yp-sheet__title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

// ── Post ────────────────────────────────────────────────────────────────
export interface PostCardProps {
  post: Post;
  locale?: string;
  linkAs?: LinkLike;
  isOwn?: boolean;
  onLike?: (post: Post) => void;
  onComment?: (post: Post) => void;
  onSave?: (post: Post) => void;
  onVote?: (post: Post, optionId: string) => void;
  onFeedback?: (post: Post, signal: 'more_like_this' | 'less_like_this' | 'not_interested' | 'mute_creator') => void;
  onWhy?: (post: Post) => void;
  onReport?: (post: Post) => void;
  onAddToMemory?: (post: Post) => void;
  onDelete?: (post: Post) => void;
}

const VIS_ICON: Record<string, IconName> = { public: 'globe', followers: 'users', friends: 'users', circle: 'users', selected: 'user', private: 'lock' };

export function PostCard({
  post,
  locale = 'en',
  linkAs: L = A,
  isOwn,
  onLike,
  onComment,
  onSave,
  onVote,
  onFeedback,
  onWhy,
  onReport,
  onDelete,
  onAddToMemory,
}: PostCardProps) {
  const tt = (k: MessageKey) => t(k, locale);
  const menu: MenuAction[] = [];
  if (onWhy) menu.push({ label: tt('post.why'), icon: 'info', onSelect: () => onWhy(post) });
  if (onAddToMemory) menu.push({ label: 'Add to a memory', icon: 'bookmark', onSelect: () => onAddToMemory(post) });
  if (onFeedback && !isOwn) {
    menu.push({ label: tt('post.moreLikeThis'), icon: 'plus', onSelect: () => onFeedback(post, 'more_like_this') });
    menu.push({ label: tt('post.lessLikeThis'), icon: 'eye', onSelect: () => onFeedback(post, 'less_like_this') });
    menu.push({ label: tt('post.notInterested'), icon: 'x', onSelect: () => onFeedback(post, 'not_interested') });
    menu.push({ label: tt('post.muteCreator'), icon: 'bell', onSelect: () => onFeedback(post, 'mute_creator') });
  }
  if (onReport && !isOwn) menu.push({ label: tt('post.report'), icon: 'flag', danger: true, onSelect: () => onReport(post) });
  if (onDelete && isOwn) menu.push({ label: tt('post.delete'), icon: 'trash', danger: true, onSelect: () => onDelete(post) });
  const totalVotes = post.poll?.options.reduce((s, o) => s + o.votes, 0) ?? 0;

  return (
    <article className="yp-post" aria-labelledby={`post-${post.id}-author`}>
      <header className="yp-post__head">
        <L href={`/u/${post.author.username}`} aria-label={post.author.displayName}>
          <Avatar name={post.author.displayName} src={post.author.avatarUrl} />
        </L>
        <div className="yp-post__who">
          <L href={`/u/${post.author.username}`} className="yp-post__name">
            <span id={`post-${post.id}-author`}>{post.author.displayName}</span>
          </L>
          <span className="yp-post__meta">
            @{post.author.username} · <time dateTime={post.createdAt}>{formatRelativeTime(post.createdAt, locale)}</time>
            {post.community ? (
              <>
                {' · '}
                <L href={`/c/${post.community.slug}`}>{post.community.name}</L>
              </>
            ) : null}{' '}
            <Icon name={VIS_ICON[post.visibility] ?? 'globe'} size={12} label={t(`visibility.${post.visibility}` as MessageKey, locale)} />
          </span>
        </div>
        {menu.length ? <Menu label="Post options" actions={menu} /> : null}
      </header>

      {post.body ? <div className="yp-post__body">{post.body}</div> : null}

      {post.poll ? (
        <div className="yp-poll" role="group" aria-label="Poll">
          {post.poll.options.map((o) => {
            const pct = totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0;
            return (
              <button key={o.id} type="button" aria-pressed={post.poll!.myVote === o.id} onClick={() => onVote?.(post, o.id)}>
                <span className="yp-poll__bar" style={{ width: post.poll!.myVote ? `${pct}%` : 0 }} aria-hidden />
                <span>{o.label}</span>
                {post.poll!.myVote ? <span>{pct}%</span> : null}
              </button>
            );
          })}
          <span className="yp-post__meta">{totalVotes} votes</span>
        </div>
      ) : null}

      {post.media.length ? (
        <div className="yp-post__media">
          <MediaGrid media={post.media} />
        </div>
      ) : null}

      {post.linkUrl || post.event || post.product || post.topics.length ? (
        <div className="yp-post__chips">
          {post.linkUrl ? (
            <a className="yp-chip" href={post.linkUrl} target="_blank" rel="noopener noreferrer nofollow">
              <Icon name="globe" />
              {safeHost(post.linkUrl)}
            </a>
          ) : null}
          {post.event ? (
            <L href={`/events/${post.event.id}`} className="yp-chip">
              <Icon name="calendar" />
              {post.event.title}
            </L>
          ) : null}
          {post.product ? (
            <span className="yp-chip">
              <Icon name="bag" />
              {post.product.title} · {formatMoney(post.product.priceCents, post.product.currency, locale)}
            </span>
          ) : null}
          {post.topics.map((tp) => (
            <L key={tp} href={`/discover?q=${encodeURIComponent(tp)}`} className="yp-chip">
              #{tp}
            </L>
          ))}
        </div>
      ) : null}

      {post.withheldIn?.length ? (
        <div className="yp-post__reason" role="note">
          <Icon name="info" size={14} />
          Withheld in {post.withheldIn.map((c) => regionName(c, locale)).join(', ')} for legal reasons.
        </div>
      ) : null}

      {post.reason || post.aiAssisted || post.real ? (
        <div className="yp-post__reason">
          {post.reason ? (
            <>
              <Icon name="info" size={14} />
              {post.reason}
            </>
          ) : null}
          {post.aiAssisted ? <Badge tone="neutral">{tt('post.aiAssisted')}</Badge> : null}
          {post.real ? (
            <Badge tone="success">Real · captured {new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(post.real.capturedAt))}</Badge>
          ) : null}
        </div>
      ) : null}

      <div className="yp-post__actions">
        <button
          type="button"
          className="yp-action"
          aria-pressed={post.viewer.liked}
          onClick={() => onLike?.(post)}
          aria-label={`${post.viewer.liked ? tt('post.unlike') : tt('post.like')}, ${post.counts.likes}`}
        >
          <Icon name="heart" filled={post.viewer.liked} />
          {post.counts.likes || ''}
        </button>
        <button type="button" className="yp-action" onClick={() => onComment?.(post)} aria-label={`${tt('post.comments')}, ${post.counts.comments}`}>
          <Icon name="message" />
          {post.counts.comments || ''}
        </button>
        <span className="yp-spacer" />
        <button type="button" className="yp-action" aria-pressed={post.viewer.saved} onClick={() => onSave?.(post)} aria-label={tt('post.save')}>
          <Icon name="bookmark" filled={post.viewer.saved} />
        </button>
      </div>
    </article>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ── Lists, chat, cards ──────────────────────────────────────────────────
export function List({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <ul className="yp-list" aria-label={label}>
      {children}
    </ul>
  );
}

export function ListItem({
  href,
  onClick,
  start,
  primary,
  secondary,
  end,
  linkAs: L = A,
}: {
  href?: string;
  onClick?: () => void;
  start?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  end?: ReactNode;
  linkAs?: LinkLike;
}) {
  const inner = (
    <>
      {start}
      <span className="yp-list__text">
        <span className="yp-list__primary">{primary}</span>
        {secondary ? <span className="yp-list__secondary">{secondary}</span> : null}
      </span>
      {end ? <span className="yp-list__end">{end}</span> : null}
    </>
  );
  return (
    <li>
      {href ? (
        <L href={href} className="yp-list__item">
          {inner}
        </L>
      ) : onClick ? (
        <button type="button" className="yp-list__item" onClick={onClick}>
          {inner}
        </button>
      ) : (
        <div className="yp-list__item">{inner}</div>
      )}
    </li>
  );
}

export function ChatBubble({ mine, sender, body, time, pending }: { mine: boolean; sender?: string; body: ReactNode; time?: string; pending?: boolean }) {
  return (
    <div className={cx('yp-bubble', mine ? 'yp-bubble--me' : 'yp-bubble--them', pending && 'yp-bubble--pending')}>
      {sender && !mine ? <span className="yp-bubble__sender">{sender}</span> : null}
      {body}
      {time ? <span className="yp-bubble__time">{pending ? 'Sending…' : time}</span> : null}
    </div>
  );
}

export function CommunityCard({
  community,
  href,
  linkAs: L = A,
  action,
}: {
  community: { name: string; description: string; memberCount: number; visibility?: string; topics?: string[] };
  href: string;
  linkAs?: LinkLike;
  action?: ReactNode;
}) {
  return (
    <div className="yp-ccard">
      <L href={href} className="yp-ccard__mark" aria-label={community.name}>
        {community.name.slice(0, 1).toUpperCase()}
      </L>
      <L href={href}>
        <h3 className="yp-ccard__title">{community.name}</h3>
      </L>
      {community.description ? <p className="yp-ccard__desc">{community.description}</p> : null}
      <span className="yp-ccard__meta">
        {community.memberCount.toLocaleString()} members{community.visibility === 'private' ? ' · Private' : ''}
      </span>
      {action}
    </div>
  );
}

export function EventCard({
  event,
  linkAs: L = A,
  locale = 'en',
}: {
  event: Pick<EventItem, 'id' | 'title' | 'startsAt' | 'timezone' | 'locationText' | 'place' | 'online' | 'counts'>;
  linkAs?: LinkLike;
  locale?: string;
}) {
  const d = new Date(event.startsAt);
  const tz = event.timezone || 'UTC';
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: tz }).format(d);
  const day = new Intl.DateTimeFormat(locale, { day: 'numeric', timeZone: tz }).format(d);
  const time = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short' }).format(d);
  return (
    <L href={`/events/${event.id}`} className="yp-ecard">
      <span className="yp-ecard__date" aria-hidden>
        <span className="yp-ecard__month">{month}</span>
        <span className="yp-ecard__day">{day}</span>
      </span>
      <span className="yp-ecard__body">
        <span className="yp-ecard__title">{event.title}</span>
        <span className="yp-ecard__meta">{time}</span>
        <span className="yp-ecard__meta">
          {event.online ? 'Online' : (event.place?.name ?? event.locationText ?? 'Location to be announced')} · {event.counts.going} going
        </span>
      </span>
    </L>
  );
}

export function ProductCard({
  product,
  locale = 'en',
  action,
}: {
  product: { kind: string; title: string; priceCents: number; currency: string; inventory: number | null; description?: string };
  locale?: string;
  action?: ReactNode;
}) {
  return (
    <div className="yp-pcard">
      <span className="yp-pcard__kind">{product.kind}</span>
      <h3 className="yp-pcard__title">{product.title}</h3>
      {product.description ? <p className="yp-ccard__desc">{product.description}</p> : null}
      <span className="yp-pcard__price">{formatMoney(product.priceCents, product.currency, locale)}</span>
      {product.inventory !== null ? <span className="yp-pcard__stock">{product.inventory > 0 ? `${product.inventory} left` : 'Sold out'}</span> : null}
      {action}
    </div>
  );
}

export function Stat({ label, value, delta }: { label: string; value: ReactNode; delta?: string }) {
  return (
    <div className="yp-stat">
      <span className="yp-stat__label">{label}</span>
      <span className="yp-stat__value">{value}</span>
      {delta ? <span className="yp-stat__delta">{delta}</span> : null}
    </div>
  );
}

export function MomentsStrip({
  groups,
  onOpen,
  onCreate,
}: {
  groups: { author: { id: string; displayName: string; avatarUrl: string | null }; moments: unknown[] }[];
  onOpen: (index: number) => void;
  onCreate?: () => void;
}) {
  return (
    <div className="yp-moments" role="list" aria-label="Moments">
      {onCreate ? (
        <button type="button" className="yp-moment" onClick={onCreate} role="listitem">
          <span className="yp-avatar yp-avatar--lg" style={{ background: 'var(--surface-sunken)', color: 'var(--yapi)' }}>
            <Icon name="plus" />
          </span>
          <span className="yp-moment__name">Your moment</span>
        </button>
      ) : null}
      {groups.map((g, i) => (
        <button
          key={g.author.id}
          type="button"
          className="yp-moment"
          onClick={() => onOpen(i)}
          role="listitem"
          aria-label={`${g.author.displayName}, ${g.moments.length} moments`}
        >
          <span className="yp-moment__ring">
            <Avatar name={g.author.displayName} src={g.author.avatarUrl} size="lg" />
          </span>
          <span className="yp-moment__name">{g.author.displayName}</span>
        </button>
      ))}
    </div>
  );
}

/** Shows AI output with its source, so people always know what the assistant produced. */
export function AIPanel({
  title,
  children,
  notice,
  actions,
  loading,
}: {
  title: string;
  children?: ReactNode;
  notice?: string;
  actions?: ReactNode;
  loading?: boolean;
}) {
  return (
    <section className="yp-ai" aria-live="polite" aria-busy={loading || undefined}>
      <div className="yp-ai__head">
        <Icon name="sparkle" />
        {title}
      </div>
      {loading ? <div className="yp-skeleton" style={{ height: 40 }} /> : <div className="yp-ai__body">{children}</div>}
      {notice ? <div className="yp-ai__notice">{notice}</div> : null}
      {actions ? <div className="yp-ai__actions">{actions}</div> : null}
    </section>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="yp-empty">
      <h2>{title}</h2>
      {body ? <p>{body}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return <div className="yp-skeleton" style={{ height, width }} aria-hidden />;
}

export function Toast({ message, onDone, ms = 3000 }: { message: string | null; onDone: () => void; ms?: number }) {
  useEffect(() => {
    if (!message) return;
    const id = setTimeout(onDone, ms);
    return () => clearTimeout(id);
  }, [message, ms, onDone]);
  return message ? (
    <div className="yp-toast" role="status">
      {message}
    </div>
  ) : null;
}

export { Button };

function regionName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames([locale ?? 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
