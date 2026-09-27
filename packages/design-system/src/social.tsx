import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import {
  extractHashtags,
  formatMoney,
  formatRelativeTime,
  safeTimeZone,
  splitRichText,
  t,
  type CaptionTrackRef,
  type EventItem,
  type MediaItem,
  type MessageKey,
  type PhotoTag,
  type Post,
  type PublicUser,
} from '@yapilapi/shared';
import { Icon, type IconName } from './icons.tsx';
import { Avatar, Badge, Button, cx, PlusBadge, useModalFocus } from './primitives.tsx';

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
  searchHref,
}: {
  items: NavEntry[];
  current?: NavEntry['id'];
  linkAs?: LinkLike;
  locale?: string;
  brandHref?: string;
  logoSrc?: string;
  /** Adds a Search button under the logo on wide screens (phones get one in the page header). */
  searchHref?: string;
}) {
  return (
    <nav className="yp-nav" aria-label="Primary">
      <L href={brandHref} className="yp-nav__brand" aria-label="YAPILAPI home">
        {logoSrc ? <img src={logoSrc} alt="" /> : null}
        YAPILAPI
      </L>
      {searchHref ? (
        <L href={searchHref} className="yp-nav__search">
          <Icon name="search" size={20} />
          Search
        </L>
      ) : null}
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
          {it.badge ? (
            <>
              <span className="yp-nav__badge" aria-hidden>
                {it.badge > 99 ? '99+' : it.badge}
              </span>
              <span className="yp-visually-hidden">, {it.badge} unread</span>
            </>
          ) : null}
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
/**
 * Covers media that automated checks marked sensitive. Place it inside a
 * positioned box over the (blurred) media; only the button takes clicks, so
 * controls around it keep working.
 */
export function SensitiveCover({ onReveal, compact }: { onReveal: () => void; compact?: boolean }) {
  return (
    <div className={cx('yp-sensitive', compact && 'yp-sensitive--compact')}>
      <Icon name="eye" size={compact ? 18 : 24} />
      <span>Sensitive content.</span>
      <button
        type="button"
        className="yp-sensitive__view"
        aria-label="View sensitive content"
        onClick={(e) => {
          e.stopPropagation();
          onReveal();
        }}
      >
        View
      </button>
    </div>
  );
}

export interface MediaTagOptions {
  linkAs?: LinkLike;
  /** The signed-in person: they can remove a tag of themselves. */
  viewerId?: string;
  /** The post's original author can remove any tag. */
  canRemoveAny?: boolean;
  onRemoveTag?: (mediaId: string, tag: PhotoTag) => void;
}

export function MediaGrid({ media, tagOptions }: { media: MediaItem[]; tagOptions?: MediaTagOptions }) {
  const [open, setOpen] = useState<number | null>(null);
  // One choice per post: viewing one sensitive item shows the others too.
  const [revealed, setRevealed] = useState(false);
  // Tapping a photo with people tagged in it shows or hides their names on every photo of the post.
  const [showTags, setShowTags] = useState(false);
  if (!media.length) return null;
  const shown = media.slice(0, 4);
  const hidden = (m: MediaItem) => !!m.sensitive && !revealed;
  // The full-screen viewer only steps through what isn't covered.
  const viewable = media.filter((m) => !hidden(m));
  return (
    <>
      <div className={cx('yp-media', `yp-media--${Math.min(shown.length, 4)}`)}>
        {shown.map((m, i) =>
          hidden(m) ? (
            <div key={m.id} className="yp-media__item yp-media__item--sensitive">
              {m.placeholder || m.posterUrl || m.variants?.thumb ? (
                <img src={m.placeholder ?? m.posterUrl ?? m.variants?.thumb} alt="" aria-hidden className="yp-blurred" />
              ) : null}
              <SensitiveCover onReveal={() => setRevealed(true)} />
            </div>
          ) : m.kind === 'image' && m.tags?.length ? (
            <TaggedPhoto
              key={m.id}
              media={m}
              src={(shown.length > 1 ? m.variants?.medium : (m.variants?.large ?? m.variants?.medium)) ?? m.url}
              label={m.altText ? m.altText : `Photo ${i + 1} of ${media.length}`}
              showTags={showTags}
              onToggle={() => setShowTags((v) => !v)}
              onOpen={() => setOpen(i)}
              more={i === 3 && media.length > 4 ? media.length - 4 : 0}
              options={tagOptions}
            />
          ) : (
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
          ),
        )}
      </div>
      {open !== null && viewable.length ? (
        <MediaViewer media={viewable} index={Math.max(0, viewable.indexOf(media[open]!))} onClose={() => setOpen(null)} />
      ) : null}
    </>
  );
}

/** Where an image's picture sits inside its element, allowing for object-fit cover or contain. */
function pictureBox(img: HTMLImageElement) {
  const bw = img.clientWidth;
  const bh = img.clientHeight;
  const nw = img.naturalWidth;
  const nh = img.naturalHeight;
  if (!bw || !bh || !nw || !nh) return null;
  const fit = getComputedStyle(img).objectFit;
  if (fit !== 'cover' && fit !== 'contain') return { left: 0, top: 0, width: bw, height: bh, bw, bh };
  const k = fit === 'cover' ? Math.max(bw / nw, bh / nh) : Math.min(bw / nw, bh / nh);
  return { left: (bw - nw * k) / 2, top: (bh - nh * k) / 2, width: nw * k, height: nh * k, bw, bh };
}

/** Which way a name bubble opens from its spot, so it stays on the photo near the edges. */
export function tagBubbleClass(x: number, y: number) {
  return cx('yp-phototag', x < 0.2 && 'yp-phototag--start', x > 0.8 && 'yp-phototag--end', y > 0.8 && 'yp-phototag--above');
}

/** A photo with people tagged in it: tap to show or hide their names, each linking to their profile. */
function TaggedPhoto({
  media: m,
  src,
  label,
  showTags,
  onToggle,
  onOpen,
  more,
  options = {},
}: {
  media: MediaItem;
  src: string;
  label: string;
  showTags: boolean;
  onToggle: () => void;
  onOpen: () => void;
  more: number;
  options?: MediaTagOptions;
}) {
  const { linkAs: L = A, viewerId, canRemoveAny, onRemoveTag } = options;
  const img = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<ReturnType<typeof pictureBox>>(null);
  const tags = m.tags ?? [];
  useEffect(() => {
    const el = img.current;
    if (!el) return;
    const measure = () => setBox(pictureBox(el));
    measure();
    el.addEventListener('load', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      el.removeEventListener('load', measure);
      ro?.disconnect();
    };
  }, [src]);
  const place = (t: PhotoTag) => {
    if (!box) return { left: `${t.x * 100}%`, top: `${t.y * 100}%` };
    const within = (v: number, max: number) => Math.min(max, Math.max(0, v));
    return { left: within(box.left + t.x * box.width, box.bw), top: within(box.top + t.y * box.height, box.bh) };
  };
  const count = tags.length === 1 ? '1 person tagged' : `${tags.length} people tagged`;
  return (
    <div className="yp-media__item yp-media__item--tagged">
      <button type="button" className="yp-media__hit" aria-pressed={showTags} onClick={onToggle} aria-label={`Show people tagged in ${label}, ${count}`}>
        <img
          ref={img}
          src={src}
          alt={m.altText ?? ''}
          loading="lazy"
          decoding="async"
          style={m.placeholder ? { backgroundImage: `url(${m.placeholder})`, backgroundSize: 'cover' } : undefined}
        />
        {more ? <span className="yp-media__more">+{more}</span> : null}
      </button>
      <span className="yp-media__people" aria-hidden>
        <Icon name="user" size={14} />
      </span>
      <button type="button" className="yp-media__open" onClick={onOpen} aria-label={`Open ${label} full screen`}>
        <Icon name="image" size={16} />
      </button>
      {showTags ? (
        <ul className="yp-phototags" aria-label={`People tagged in ${label}`}>
          {tags.map((t) => {
            const self = !!viewerId && t.user.id === viewerId;
            const removable = !!onRemoveTag && (self || !!canRemoveAny);
            return (
              <li key={t.id} className={tagBubbleClass(t.x, t.y)} style={place(t)}>
                <span className="yp-phototag__bubble">
                  <L href={`/u/${t.user.username}`} className="yp-phototag__name" aria-label={`${t.user.displayName}, @${t.user.username}`}>
                    <bdi>{t.user.displayName}</bdi>
                  </L>
                  {removable ? (
                    <button
                      type="button"
                      className="yp-phototag__remove"
                      onClick={() => onRemoveTag!(m.id, t)}
                      aria-label={self ? 'Remove me from this photo' : `Remove tag for ${t.user.displayName}`}
                    >
                      {self ? 'Remove me' : <Icon name="x" size={12} />}
                    </button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
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
  useModalFocus(ref, true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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

/**
 * Menu button (WAI-ARIA menu pattern): Enter, Space or ArrowDown opens it on the
 * first item, arrows/Home/End move, Escape closes and returns focus to the button,
 * Tab closes it and moves on.
 */
export function Menu({ label, actions, icon = 'more' }: { label: string; actions: MenuAction[]; icon?: IconName }) {
  const [open, setOpen] = useState<false | 'first' | 'last'>(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const items = () => [...(wrap.current?.querySelectorAll<HTMLButtonElement>('.yp-menu__item') ?? [])];
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    const list = items();
    (open === 'last' ? list.at(-1) : list[0])?.focus();
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(e.key === 'ArrowUp' ? 'last' : 'first');
      }
      return;
    }
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: list.length - 1 }[e.key];
    if (move !== undefined) {
      e.preventDefault();
      list[(move + list.length) % list.length]?.focus();
    } else if (e.key === 'Escape') {
      // Handled here so an enclosing dialog or sheet stays open.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'Tab') setOpen(false);
  };
  return (
    <div className="yp-menu" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={trigger}
        type="button"
        className="yp-action"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => (o ? false : 'first'))}
      >
        <Icon name={icon} />
      </button>
      {open ? (
        <ul className="yp-menu__list" role="menu" id={listId} aria-label={label}>
          {actions.map((a) => (
            <li key={a.label} role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={cx('yp-menu__item', a.danger && 'yp-menu__item--danger')}
                onClick={() => {
                  setOpen(false);
                  // Focus goes back to the button first, so a sheet or dialog the
                  // action opens returns focus there when it closes.
                  trigger.current?.focus();
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
  useModalFocus(ref, open, onClose);
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
/** Text with each #tag linked to its tag page and each @mention to that profile. */
export function TaggedText({ text, linkAs: L = A }: { text: string; linkAs?: LinkLike }) {
  return (
    <>
      {splitRichText(text).map((part, i) =>
        'tag' in part ? (
          <L key={i} href={`/t/${encodeURIComponent(part.tag)}`} className="yp-hashtag">
            {part.text}
          </L>
        ) : 'mention' in part ? (
          <L key={i} href={`/u/${part.mention}`} className="yp-hashtag">
            {part.text}
          </L>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

export interface PostCardProps {
  post: Post;
  locale?: string;
  linkAs?: LinkLike;
  isOwn?: boolean;
  onLike?: (post: Post) => void;
  onComment?: (post: Post) => void;
  onSave?: (post: Post) => void;
  /**
   * Open "Save to a board": a "Save to a board" item in the post menu, and a long press
   * (about half a second) or right-click on the save button. A normal click still saves.
   */
  onSaveTo?: (post: Post) => void;
  /** Share someone else's public post with your followers. */
  onRepost?: (post: Post) => void;
  /** Share a link to the post (the system share sheet, or copy the link). */
  onShare?: (post: Post) => void;
  onVote?: (post: Post, optionId: string) => void;
  onFeedback?: (post: Post, signal: 'more_like_this' | 'less_like_this' | 'not_interested' | 'mute_creator') => void;
  onWhy?: (post: Post) => void;
  onReport?: (post: Post) => void;
  onAddToMemory?: (post: Post) => void;
  onDelete?: (post: Post) => void;
  /** Pin to or unpin from the top of your profile (own posts only). */
  onPin?: (post: Post) => void;
  /** Boost one of your own public posts (opens the boost sheet). */
  onBoost?: (post: Post) => void;
  /** The signed-in person's id: a tagged person can remove their own tag. */
  viewerId?: string;
  /** Answer an invite to co-author the post (shown when post.viewer.collab is 'pending'). */
  onAcceptCollab?: (post: Post) => void;
  onDeclineCollab?: (post: Post) => void;
  /** Stop being a co-author (post.viewer.collab is 'accepted'); the post comes off your profile. */
  onLeaveCollab?: (post: Post) => void;
  /** Remove a photo tag: the original author can remove any, the person tagged their own. */
  onRemoveTag?: (post: Post, mediaId: string, tag: PhotoTag) => void;
  /** Original author: invite co-authors or take them off (own posts only). */
  onManageCollaborators?: (post: Post) => void;
}

type Person = Pick<PublicUser, 'id' | 'username' | 'displayName'>;

/** "Ada", "Ada and Bola" or "Ada, Bola and Chi" as plain text. */
export function joinNames(people: Person[]): string {
  const names = people.map((p) => p.displayName);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** "Ada and Bola" (or "Ada, Bola and Chi"), each name linking to that profile. */
export function AuthorNames({ people, linkAs: L = A, linkClassName }: { people: Person[]; linkAs?: LinkLike; linkClassName?: string }) {
  return (
    <>
      {people.map((p, i) => (
        <span key={p.id}>
          {i === 0 ? '' : i === people.length - 1 ? ' and ' : ', '}
          <L href={`/u/${p.username}`} className={linkClassName}>
            <bdi>{p.displayName}</bdi>
          </L>
        </span>
      ))}
    </>
  );
}

const VIS_ICON: Record<string, IconName> = {
  public: 'globe',
  followers: 'users',
  friends: 'users',
  circle: 'users',
  selected: 'user',
  private: 'lock',
  subscribers: 'star',
};

export function PostCard({
  post,
  locale = 'en',
  linkAs: L = A,
  isOwn,
  onLike,
  onComment,
  onSave,
  onSaveTo,
  onRepost,
  onShare,
  onVote,
  onFeedback,
  onWhy,
  onReport,
  onDelete,
  onAddToMemory,
  onPin,
  onBoost,
  viewerId,
  onAcceptCollab,
  onDeclineCollab,
  onLeaveCollab,
  onRemoveTag,
  onManageCollaborators,
}: PostCardProps) {
  const tt = (k: MessageKey) => t(k, locale);
  const coauthors = post.collaborators ?? [];
  const pendingCoauthors = isOwn ? (post.pendingCollaborators ?? []) : [];
  // A co-author shares the post but only the original author can change or delete it.
  const coauthor = post.viewer.collab === 'accepted';
  const invited = post.viewer.collab === 'pending';
  const menu: MenuAction[] = [];
  const saveHold = useLongPress(onSaveTo ? () => onSaveTo(post) : undefined);
  if (onWhy) menu.push({ label: tt('post.why'), icon: 'info', onSelect: () => onWhy(post) });
  if (onSaveTo) menu.push({ label: 'Save to a board', icon: 'bookmark', onSelect: () => onSaveTo(post) });
  if (onAddToMemory) menu.push({ label: 'Add to a memory', icon: 'bookmark', onSelect: () => onAddToMemory(post) });
  if (onLeaveCollab && coauthor && !isOwn) menu.push({ label: 'Leave as co-author', icon: 'logout', onSelect: () => onLeaveCollab(post) });
  if (onFeedback && !isOwn && !coauthor) {
    menu.push({ label: tt('post.moreLikeThis'), icon: 'plus', onSelect: () => onFeedback(post, 'more_like_this') });
    menu.push({ label: tt('post.lessLikeThis'), icon: 'eye', onSelect: () => onFeedback(post, 'less_like_this') });
    menu.push({ label: tt('post.notInterested'), icon: 'x', onSelect: () => onFeedback(post, 'not_interested') });
    menu.push({ label: tt('post.muteCreator'), icon: 'bell', onSelect: () => onFeedback(post, 'mute_creator') });
  }
  if (onReport && !isOwn && !coauthor) menu.push({ label: tt('post.report'), icon: 'flag', danger: true, onSelect: () => onReport(post) });
  if (onPin && isOwn && !post.community)
    menu.push({ label: post.pinned ? 'Unpin from profile' : 'Pin to profile', icon: 'bookmark', onSelect: () => onPin(post) });
  if (onManageCollaborators && isOwn && !post.community)
    menu.push({
      label: coauthors.length || pendingCoauthors.length ? 'Co-authors' : 'Invite co-authors',
      icon: 'users',
      onSelect: () => onManageCollaborators(post),
    });
  if (onBoost && isOwn && post.visibility === 'public' && !post.community)
    menu.push({ label: tt('post.boost'), icon: 'sparkle', onSelect: () => onBoost(post) });
  if (onDelete && isOwn) menu.push({ label: tt('post.delete'), icon: 'trash', danger: true, onSelect: () => onDelete(post) });
  const totalVotes = post.poll?.options.reduce((s, o) => s + o.votes, 0) ?? 0;
  // Tags already linked in the text don't need a chip too.
  const inText = extractHashtags(post.body, 50);
  const chipTopics = post.topics.filter((tp) => !inText.includes(tp));

  return (
    <article className="yp-post" aria-labelledby={`post-${post.id}-author`}>
      {post.pinned ? (
        <p className="yp-post__pinned">
          <Icon name="bookmark" size={12} filled />
          Pinned
        </p>
      ) : null}
      <header className="yp-post__head">
        <L href={`/u/${post.author.username}`} aria-label={post.author.displayName}>
          <Avatar name={post.author.displayName} src={post.author.avatarUrl} />
        </L>
        <div className="yp-post__who">
          <span className="yp-post__nameline">
            {coauthors.length ? (
              <span className="yp-post__names" id={`post-${post.id}-author`}>
                <AuthorNames people={[post.author, ...coauthors]} linkAs={L} linkClassName="yp-post__name" />
              </span>
            ) : (
              <>
                <L href={`/u/${post.author.username}`} className="yp-post__name">
                  <bdi id={`post-${post.id}-author`}>{post.author.displayName}</bdi>
                </L>
                {post.author.plus ? <PlusBadge label={t('plus.badge.label', locale)} /> : null}
              </>
            )}
          </span>
          <span className="yp-post__meta">
            <bdi>@{post.author.username}</bdi> ·{' '}
            <bdi>
              <time dateTime={post.createdAt}>{formatRelativeTime(post.createdAt, locale)}</time>
            </bdi>
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

      {invited && onAcceptCollab && onDeclineCollab ? (
        <div className="yp-post__invite" role="group" aria-label="Invite to co-author">
          <span>
            <bdi>{post.author.displayName}</bdi> invited you to co-author this post
          </span>
          <span className="yp-post__invite-actions">
            <Button size="sm" onClick={() => onAcceptCollab(post)}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDeclineCollab(post)}>
              Decline
            </Button>
          </span>
        </div>
      ) : null}
      {pendingCoauthors.length ? (
        <p className="yp-post__reason yp-post__pending">
          <Icon name="users" size={14} />
          <span>Waiting for {joinNames(pendingCoauthors)} to accept</span>
        </p>
      ) : null}

      {post.body ? (
        <div className="yp-post__body" dir="auto">
          <TaggedText text={post.body} linkAs={L} />
        </div>
      ) : null}

      {post.locked ? <LockedPanel post={post} locale={locale} linkAs={L} /> : null}
      {post.remixOf || post.sound ? (
        <p className="yp-post__reel">
          {post.remixOf ? (
            post.remixOf.post ? (
              <L href={`/reels?start=${post.remixOf.post.id}`} className="yp-post__reel-link">
                <Icon name="duet" size={14} />
                {post.remixOf.mode === 'duet' ? 'Duet with' : 'Remix of'} <bdi>@{post.remixOf.post.author.username}</bdi>
              </L>
            ) : (
              <span className="yp-post__reel-link">
                <Icon name="duet" size={14} />
                {post.remixOf.mode === 'duet' ? 'Duet with a reel that is no longer available' : 'Remix of a reel that is no longer available'}
              </span>
            )
          ) : null}
          {post.sound ? (
            <L href={`/sounds/${post.sound.id}`} className="yp-post__reel-link">
              <Icon name="music" size={14} />
              <bdi>{post.sound.title}</bdi>
            </L>
          ) : null}
        </p>
      ) : null}

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
          <MediaGrid
            media={post.media}
            tagOptions={{
              linkAs: L,
              viewerId,
              canRemoveAny: isOwn,
              onRemoveTag: onRemoveTag ? (mediaId, tag) => onRemoveTag(post, mediaId, tag) : undefined,
            }}
          />
        </div>
      ) : null}

      {post.format === 'reel' || post.linkUrl || post.event || post.product || chipTopics.length ? (
        <div className="yp-post__chips">
          {post.format === 'reel' ? (
            <L href={`/reels?start=${post.id}`} className="yp-chip">
              <Icon name="sparkle" />
              Reel · watch full screen
            </L>
          ) : null}
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
          {chipTopics.map((tp) => (
            <L key={tp} href={`/t/${encodeURIComponent(tp)}`} className="yp-chip">
              <bdi>#{tp}</bdi>
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

      {post.boost ? (
        <div className="yp-post__reason yp-post__boost" role="note">
          <Icon name="sparkle" size={14} />
          <span>{tt(`post.boost.status.${post.boost.status}` as MessageKey)}</span>
          {post.boost.impressions || post.boost.spentCents ? (
            <span>
              {t('post.boost.results', locale, {
                impressions: new Intl.NumberFormat(locale).format(post.boost.impressions),
                clicks: new Intl.NumberFormat(locale).format(post.boost.clicks),
                spent: formatMoney(post.boost.spentCents, post.boost.currency, locale),
              })}
            </span>
          ) : null}
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
        {onRepost && !isOwn && !coauthor && post.visibility === 'public' ? (
          <button
            type="button"
            className={cx('yp-action', post.viewer.reposted && 'yp-action--reposted')}
            aria-pressed={post.viewer.reposted}
            onClick={() => onRepost(post)}
            aria-label={`${post.viewer.reposted ? 'Undo repost' : 'Repost'}, ${post.counts.reposts}`}
          >
            <Icon name="repost" />
            {post.counts.reposts || ''}
          </button>
        ) : post.counts.reposts ? (
          <span className="yp-action yp-action--static" aria-label={`Reposts, ${post.counts.reposts}`}>
            <Icon name="repost" />
            {post.counts.reposts}
          </span>
        ) : null}
        {onShare && post.visibility !== 'private' ? (
          <button type="button" className="yp-action" onClick={() => onShare(post)} aria-label="Share">
            <Icon name="send" />
          </button>
        ) : null}
        <span className="yp-spacer" />
        <button
          type="button"
          className={cx('yp-action', onSaveTo && 'yp-action--hold')}
          aria-pressed={post.viewer.saved}
          aria-label={tt('post.save')}
          {...saveHold.handlers}
          onClick={() => {
            if (saveHold.wasHeld()) return;
            onSave?.(post);
          }}
        >
          <Icon name="bookmark" filled={post.viewer.saved} />
        </button>
      </div>
    </article>
  );
}

/**
 * A long press (about 500 ms) or a right-click (contextmenu) runs `onHold`. Spread `handlers`
 * on a button and check `wasHeld()` first thing in its click handler, so the click that ends a
 * long press doesn't also count as a click. Without `onHold` it does nothing.
 */
export function useLongPress(onHold?: () => void, ms = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);
  const wasHeld = () => {
    const was = held.current;
    held.current = false;
    return was;
  };
  if (!onHold) return { handlers: {}, wasHeld };
  const handlers = {
    onPointerDown: (e: { button: number }) => {
      held.current = false;
      cancel();
      if (e.button !== 0) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        held.current = true;
        onHold();
      }, ms);
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: { preventDefault: () => void }) => {
      e.preventDefault();
      // Touch browsers fire contextmenu during a long press too: open once.
      if (held.current && !timer.current) return;
      const pressing = !!timer.current;
      cancel();
      if (pressing) held.current = true;
      onHold();
    },
  };
  return { handlers, wasHeld };
}

/**
 * A subscriber-only post the viewer can't open: a blurred preview (a tiny
 * image the server sends instead of the media), who it's from, and a link to
 * subscribe on the author's profile.
 */
function LockedPanel({ post, locale, linkAs: L }: { post: Post; locale: string; linkAs: LinkLike }) {
  const placeholder = post.locked?.placeholder;
  const bg = placeholder && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(placeholder) ? { backgroundImage: `url(${placeholder})` } : undefined;
  return (
    <div className={`yp-post__locked${bg ? ' yp-post__locked--media' : ''}`} style={bg}>
      <div className="yp-post__locked-inner">
        <Icon name="lock" size={22} />
        <strong>{t('post.locked.title', locale)}</strong>
        <span>{t('post.locked.body', locale, { name: post.author.displayName })}</span>
        <L href={`/u/${post.author.username}?subscribe=1`} className="yp-btn yp-btn--primary yp-btn--sm">
          {t('post.locked.cta', locale)}
        </L>
      </div>
    </div>
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
        <bdi className="yp-list__primary">{primary}</bdi>
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
      {sender && !mine ? <bdi className="yp-bubble__sender">{sender}</bdi> : null}
      <span dir="auto">{body}</span>
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
  const tz = safeTimeZone(event.timezone);
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
  groups: {
    author: { id: string; displayName: string; avatarUrl: string | null };
    moments: { closeFriends?: boolean; seen?: boolean }[];
    allSeen?: boolean;
    mine?: boolean;
  }[];
  onOpen: (index: number) => void;
  onCreate?: () => void;
}) {
  const hasOwn = groups.some((g) => g.mine);
  return (
    <ul className="yp-moments" aria-label="Stories">
      {onCreate && !hasOwn ? (
        <li>
          <button type="button" className="yp-moment" onClick={onCreate}>
            <span className="yp-avatar yp-avatar--lg" style={{ background: 'var(--surface-sunken)', color: 'var(--yapi)' }} aria-hidden>
              <Icon name="plus" />
            </span>
            <span className="yp-moment__name">Your story</span>
          </button>
        </li>
      ) : null}
      {groups.map((g, i) => {
        // A green ring for close friends stories you haven't seen (or your own).
        const close = g.moments.some((m) => m.closeFriends && (g.mine || !m.seen));
        return (
          <li key={g.author.id}>
            <button
              type="button"
              className="yp-moment"
              onClick={() => onOpen(i)}
              aria-label={`${g.mine ? 'Your story' : g.author.displayName}, ${g.moments.length} ${g.moments.length === 1 ? 'story' : 'stories'}${g.allSeen ? ', seen' : ', new'}${close ? ', close friends' : ''}`}
            >
              <span className={close ? 'yp-moment__ring yp-moment__ring--close' : g.allSeen ? 'yp-moment__ring yp-moment__ring--seen' : 'yp-moment__ring'}>
                <Avatar name={g.author.displayName} src={g.author.avatarUrl} size="lg" />
              </span>
              <span className="yp-moment__name">
                <bdi>{g.mine ? 'Your story' : g.author.displayName}</bdi>
              </span>
            </button>
            {g.mine && onCreate ? (
              <button type="button" className="yp-moment__add" onClick={onCreate} aria-label="Add to your story">
                <Icon name="plus" size={14} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
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

/** An optional button in a toast, such as "Add to a board" after saving. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * A short message at the bottom of the screen. With an `action`, it stays longer (6 seconds by
 * default) and the action is a real button; the timer pauses while the pointer or focus is on it.
 */
export function Toast({ message, onDone, ms, action }: { message: string | null; onDone: () => void; ms?: number; action?: ToastAction | null }) {
  const [held, setHeld] = useState(false);
  const wait = ms ?? (action ? 6000 : 3000);
  useEffect(() => {
    if (!message || held) return;
    const id = setTimeout(onDone, wait);
    return () => clearTimeout(id);
  }, [message, wait, onDone, held, action]);
  useEffect(() => {
    if (!message) setHeld(false);
  }, [message]);
  return message ? (
    <div
      className={cx('yp-toast', action && 'yp-toast--action')}
      role="status"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <span>{message}</span>
      {action ? (
        <button
          type="button"
          className="yp-toast__action"
          onClick={() => {
            action.onClick();
            onDone();
          }}
        >
          {action.label}
        </button>
      ) : null}
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
