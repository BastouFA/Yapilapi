import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {
  extractHashtags,
  formatBytes,
  formatMoney,
  imageSrc,
  initialsOf,
  videoPoster,
  videoSrc,
  formatRelativeTime,
  isRtl,
  postReasonText,
  safeTimeZone,
  smallAvatarUrl,
  splitRichText,
  t,
  type CaptionTrackRef,
  type EventItem,
  type MediaItem,
  type MessageKey,
  type MixCard,
  type PhotoTag,
  type PluralKey,
  type Post,
  type PostMusic,
  type PostVersion,
  type PublicUser,
} from '@yapilapi/shared';
import { Icon, type IconName } from './icons.tsx';
import { Avatar, Badge, Button, cx, PlusBadge, useModalFocus } from './primitives.tsx';
import { useDataSaver } from './data-saver.tsx';
import { TranslatableText } from './translation.tsx';

// ── Translation helpers ─────────────────────────────────────────────────
type Vars = Record<string, string | number>;

/**
 * t() for design-system components. In a right-to-left language each text value
 * put into the sentence is wrapped in first-strong isolates (as the web app's
 * t() does), so an English name inside Arabic text keeps its own direction.
 */
function tr(key: MessageKey, locale: string, vars?: Vars): string {
  if (!vars || !isRtl(locale)) return t(key, locale, vars);
  const out: Vars = {};
  for (const [k, v] of Object.entries(vars)) out[k] = typeof v === 'string' && v ? `⁨${v}⁩` : v;
  return t(key, locale, out);
}

/** Plural-aware tr(): picks `<key>.one` or `<key>.other` and passes {count}, formatted for the locale. */
function trp(key: PluralKey, count: number, locale: string): string {
  let one = count === 1;
  try {
    one = new Intl.PluralRules(locale).select(count) === 'one';
  } catch {
    // An unknown locale tag: English rules.
  }
  return t(`${key}.${one ? 'one' : 'other'}` as MessageKey, locale, { count: new Intl.NumberFormat(locale).format(count) });
}

/** "a, b and c" in the reader's language. */
function joinList(items: string[], locale: string): string {
  if (items.length <= 1) return items[0] ?? '';
  return items.slice(0, -1).join(t('m.collab.joinSep', locale)) + t('m.collab.joinLast', locale) + items.at(-1);
}

/**
 * Puts an element (a link, a <time>) where `{name}` sits in a translated sentence, so the
 * sentence keeps its word order in every language. A "@" right before the placeholder is
 * passed to `render`, to keep it inside the same isolated run as the name.
 */
function fill(text: string, name: string, render: (at: string) => ReactNode): ReactNode[] {
  return text.split(new RegExp(`(@?\\{${name}\\})`)).map((part, i) => (i % 2 ? <Fragment key={i}>{render(part.startsWith('@') ? '@' : '')}</Fragment> : part));
}

/** A link component (e.g. next/link). Defaults to a plain anchor. */
export type LinkLike = ComponentType<{
  href: string;
  className?: string;
  children?: ReactNode;
  'aria-current'?: 'page' | undefined;
  'aria-label'?: string;
  'aria-describedby'?: string;
}>;
const A: LinkLike = ({ href, children, ...rest }) => (
  <a href={href} {...rest}>
    {children}
  </a>
);

// ── Navigation ──────────────────────────────────────────────────────────
export interface NavEntry {
  /** Pulse, Wander, Spark, Yap and You; the ids (and URLs) keep their original names. */
  id: 'home' | 'discover' | 'create' | 'inbox' | 'profile';
  href: string;
  badge?: number;
  /** "You" shows the signed-in person's own avatar (their initials when there is no photo). */
  avatar?: { name: string; src?: string | null };
}
const NAV_GLYPH: Record<Exclude<NavEntry['id'], 'profile'>, IconName> = { home: 'pulse', discover: 'wander', create: 'spark', inbox: 'yap' };

/** The person's avatar in a soft squircle; a thin brand-gradient ring when "You" is the current page. */
function NavAvatar({ name, src }: { name: string; src?: string | null }) {
  const small = smallAvatarUrl(src);
  const [failed, setFailed] = useState<string | null>(null);
  const initials = initialsOf(name);
  // Initials come from CSS (data-initials) so they stay out of the link's text: its name is "You".
  return (
    <span className="yp-nav__you" data-initials={src ? undefined : initials}>
      {src ? <img src={small && failed !== small ? small : src} alt="" onError={small && small !== src ? () => setFailed(small) : undefined} /> : null}
    </span>
  );
}

/**
 * Primary navigation: Pulse | Wander | Spark | Yap | You (ids home, discover, create, inbox, profile).
 * Phones: a floating dock. Icons only, except the current page, whose label sits with its icon
 * in a squircle highlight that slides between tabs; other labels show on hover and keyboard focus
 * and are always in the links' accessible names. Spark is a raised, slightly tilted brand-gradient
 * squircle that straightens when pressed. Wide screens: a side rail with every label visible.
 */
export function NavBar({
  items,
  current,
  linkAs: L = A,
  locale = 'en',
  brandHref = '/home',
  logoSrc,
  searchHref,
  footer,
}: {
  items: NavEntry[];
  current?: NavEntry['id'];
  linkAs?: LinkLike;
  locale?: string;
  brandHref?: string;
  logoSrc?: string;
  /** Adds a Search button under the logo on wide screens (phones get one in the page header). */
  searchHref?: string;
  /** Pinned to the bottom of the side rail on wide screens (the account button); hidden in the phone dock. */
  footer?: ReactNode;
}) {
  const hints = useId();
  // Where the highlight sits: the current tab, unless that is Spark (which has its own look).
  const at = items.findIndex((it) => it.id === current && it.id !== 'create');
  const sparkAt = items.findIndex((it) => it.id === 'create');
  const place = {
    '--yp-nav-n': items.length,
    '--yp-nav-i': Math.max(at, 0),
    '--yp-nav-past-spark': sparkAt >= 0 && at > sparkAt ? 1 : 0,
  } as CSSProperties;
  return (
    <nav className="yp-nav" aria-label={t('ds.nav.primary', locale)}>
      <L href={brandHref} className="yp-nav__brand" aria-label={t('ds.nav.home', locale)}>
        {logoSrc ? <img src={logoSrc} alt="" /> : null}
        YAPILAPI
      </L>
      {searchHref ? (
        <L href={searchHref} className="yp-nav__search">
          <Icon name="search" size={20} />
          {t('m.discover.search', locale)}
        </L>
      ) : null}
      <div className={cx('yp-nav__list', at >= 0 && 'yp-nav__list--placed')} style={place}>
        <span className="yp-nav__glow" aria-hidden />
        {items.map((it) => {
          const on = it.id === current;
          return (
            <L
              key={it.id}
              href={it.href}
              className={cx('yp-nav__item', `yp-nav__item--${it.id}`)}
              aria-current={on ? 'page' : undefined}
              aria-describedby={`${hints}-${it.id}`}
            >
              <span className="yp-nav__icon">
                {it.id === 'profile' ? (
                  <NavAvatar name={it.avatar?.name ?? ''} src={it.avatar?.src} />
                ) : (
                  <Icon name={NAV_GLYPH[it.id]} size={24} filled={on || it.id === 'create'} />
                )}
              </span>
              <span className="yp-nav__label">{t(`nav.${it.id}` as MessageKey, locale)}</span>
              {it.badge ? (
                <>
                  <span className="yp-nav__badge" aria-hidden>
                    {it.badge > 99 ? '99+' : new Intl.NumberFormat(locale).format(it.badge)}
                  </span>
                  <span className="yp-visually-hidden">
                    {t('m.collab.joinSep', locale)}
                    {t('m.inbox.unread', locale, { count: new Intl.NumberFormat(locale).format(it.badge) })}
                  </span>
                </>
              ) : null}
            </L>
          );
        })}
      </div>
      {footer ? <div className="yp-nav__foot">{footer}</div> : null}
      {/* What each place is for, read after its name ("Pulse, link, What your people are up to"). */}
      {items.map((it) => (
        <span key={it.id} id={`${hints}-${it.id}`} hidden>
          {t(`nav.hint.${it.id}` as MessageKey, locale)}
        </span>
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
export function SensitiveCover({ onReveal, compact, locale = 'en' }: { onReveal: () => void; compact?: boolean; locale?: string }) {
  return (
    <div className={cx('yp-sensitive', compact && 'yp-sensitive--compact')}>
      <Icon name="eye" size={compact ? 18 : 24} />
      <span>{t('m.sensitive.label', locale)}</span>
      <button
        type="button"
        className="yp-sensitive__view"
        aria-label={t('m.sensitive.viewA11y', locale)}
        onClick={(e) => {
          e.stopPropagation();
          onReveal();
        }}
      >
        {t('m.sensitive.view', locale)}
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

export function MediaGrid({ media, tagOptions, locale = 'en' }: { media: MediaItem[]; tagOptions?: MediaTagOptions; locale?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  // One choice per post: viewing one sensitive item shows the others too.
  const [revealed, setRevealed] = useState(false);
  // Tapping a photo with people tagged in it shows or hides their names on every photo of the post.
  const [showTags, setShowTags] = useState(false);
  // Data saver: photos load small first; "Load full photo" swaps in the full size, one photo at a time.
  const saver = useDataSaver();
  const [full, setFull] = useState<ReadonlySet<string>>(() => new Set());
  if (!media.length) return null;
  const shown = media.slice(0, 4);
  const hidden = (m: MediaItem) => !!m.sensitive && !revealed;
  // The full-screen viewer only steps through what isn't covered.
  const viewable = media.filter((m) => !hidden(m));
  const photoSrc = (m: MediaItem) => imageSrc(m, { saver, full: full.has(m.id), grid: shown.length > 1 });
  const loadFull = (m: MediaItem) =>
    saver && !full.has(m.id) && photoSrc(m) !== imageSrc(m, { saver, full: true, grid: shown.length > 1 })
      ? () => setFull((f) => new Set(f).add(m.id))
      : undefined;
  const pos = (i: number) => ({ index: new Intl.NumberFormat(locale).format(i + 1), total: new Intl.NumberFormat(locale).format(media.length) });
  const openLabel = (m: MediaItem, i: number) => (m.altText ? tr('ds.media.open', locale, { alt: m.altText }) : t('ds.media.openOf', locale, pos(i)));
  return (
    <>
      <div className={cx('yp-media', `yp-media--${Math.min(shown.length, 4)}`)}>
        {shown.map((m, i) =>
          hidden(m) ? (
            <div key={m.id} className="yp-media__item yp-media__item--sensitive">
              {m.placeholder || m.posterUrl || m.variants?.thumb ? (
                <img src={m.placeholder ?? m.posterUrl ?? m.variants?.thumb} alt="" aria-hidden className="yp-blurred" />
              ) : null}
              <SensitiveCover onReveal={() => setRevealed(true)} locale={locale} />
            </div>
          ) : m.kind === 'image' && m.tags?.length ? (
            <TaggedPhoto
              key={m.id}
              media={m}
              src={photoSrc(m)}
              locale={locale}
              label={m.altText ? m.altText : t('ds.media.photoOf', locale, pos(i))}
              showTags={showTags}
              onToggle={() => setShowTags((v) => !v)}
              onOpen={() => setOpen(i)}
              more={i === 3 && media.length > 4 ? media.length - 4 : 0}
              options={tagOptions}
              onLoadFull={loadFull(m)}
            />
          ) : m.kind === 'image' && loadFull(m) ? (
            <div key={m.id} className="yp-media__item yp-media__item--saver">
              <button type="button" className="yp-media__hit" onClick={() => setOpen(i)} aria-label={openLabel(m, i)}>
                <img
                  src={photoSrc(m)}
                  alt={m.altText ?? ''}
                  loading="lazy"
                  decoding="async"
                  style={m.placeholder ? { backgroundImage: `url(${m.placeholder})`, backgroundSize: 'cover' } : undefined}
                />
                {m.altText ? <AltBadge locale={locale} /> : null}
                {i === 3 && media.length > 4 ? <span className="yp-media__more">+{media.length - 4}</span> : null}
              </button>
              <LoadFullPhoto media={m} onLoad={loadFull(m)!} locale={locale} />
            </div>
          ) : (
            <button key={m.id} type="button" className="yp-media__item" onClick={() => setOpen(i)} aria-label={openLabel(m, i)}>
              {m.kind === 'video' ? (
                <>
                  <video src={videoSrc(m, saver)} poster={videoPoster(m, saver)} muted playsInline preload={saver ? 'none' : 'metadata'} />
                  {saver ? (
                    <span className="yp-media__play" aria-hidden>
                      <Icon name="play" size={22} />
                    </span>
                  ) : null}
                </>
              ) : m.kind === 'audio' ? (
                <span className="yp-media__more">♪</span>
              ) : (
                <img
                  src={photoSrc(m)}
                  alt={m.altText ?? ''}
                  loading="lazy"
                  decoding="async"
                  style={m.placeholder ? { backgroundImage: `url(${m.placeholder})`, backgroundSize: 'cover' } : undefined}
                />
              )}
              {m.altText && m.kind !== 'audio' ? <AltBadge locale={locale} /> : null}
              {i === 3 && media.length > 4 ? <span className="yp-media__more">+{media.length - 4}</span> : null}
            </button>
          ),
        )}
      </div>
      {open !== null && viewable.length ? (
        <MediaViewer media={viewable} index={Math.max(0, viewable.indexOf(media[open]!))} onClose={() => setOpen(null)} locale={locale} />
      ) : null}
    </>
  );
}

/** Data saver: the button that loads a photo's full size, with what it costs when the size is known. */
function LoadFullPhoto({ media: m, onLoad, locale }: { media: MediaItem; onLoad: () => void; locale: string }) {
  const bytes = m.sizes?.large ?? m.sizes?.medium ?? m.sizes?.original;
  return (
    <button type="button" className="yp-media__full" onClick={onLoad}>
      <Icon name="image" size={14} />
      {bytes ? tr('dataSaver.loadFullSize', locale, { size: formatBytes(bytes) }) : t('dataSaver.loadFull', locale)}
    </button>
  );
}

/** "ALT" on a photo or video that has a description: opening it shows the description under it. Screen readers get the description itself. */
function AltBadge({ locale }: { locale: string }) {
  return (
    <span className="yp-media__alt" aria-hidden>
      {t('ds.media.alt', locale)}
    </span>
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
  onLoadFull,
  locale,
}: {
  media: MediaItem;
  src: string;
  label: string;
  locale: string;
  showTags: boolean;
  onToggle: () => void;
  onOpen: () => void;
  more: number;
  options?: MediaTagOptions;
  /** Data saver: shown while the small size is on screen. */
  onLoadFull?: () => void;
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
  const count = trp('m.tags.count', tags.length, locale);
  return (
    <div className="yp-media__item yp-media__item--tagged">
      <button
        type="button"
        className="yp-media__hit"
        aria-pressed={showTags}
        onClick={onToggle}
        aria-label={tr('ds.media.showTags', locale, { label, tagged: count })}
      >
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
      <button type="button" className="yp-media__open" onClick={onOpen} aria-label={tr('ds.media.openFull', locale, { label })}>
        <Icon name="image" size={16} />
      </button>
      {onLoadFull ? <LoadFullPhoto media={m} onLoad={onLoadFull} locale={locale} /> : null}
      {showTags ? (
        <ul className="yp-phototags" aria-label={tr('ds.media.peopleTagged', locale, { label })}>
          {tags.map((tag) => {
            const self = !!viewerId && tag.user.id === viewerId;
            const removable = !!onRemoveTag && (self || !!canRemoveAny);
            return (
              <li key={tag.id} className={tagBubbleClass(tag.x, tag.y)} style={place(tag)}>
                <span className="yp-phototag__bubble">
                  <L href={`/u/${tag.user.username}`} className="yp-phototag__name" aria-label={`${tag.user.displayName}, @${tag.user.username}`}>
                    <bdi>{tag.user.displayName}</bdi>
                  </L>
                  {removable ? (
                    <button
                      type="button"
                      className="yp-phototag__remove"
                      onClick={() => onRemoveTag!(m.id, tag)}
                      aria-label={self ? t('ds.media.removeMeA11y', locale) : tr('ds.media.removeTag', locale, { name: tag.user.displayName })}
                    >
                      {self ? t('ds.media.removeMe', locale) : <Icon name="x" size={12} />}
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
export function MediaViewer({ media, index, onClose, locale = 'en' }: { media: MediaItem[]; index: number; onClose: () => void; locale?: string }) {
  const [i, setI] = useState(index);
  // Data saver: videos wait for play and use the lowest MP4; photos open at the medium size.
  const saver = useDataSaver();
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
    <div className="yp-viewer" role="dialog" aria-modal aria-label={t('ds.media.viewer', locale)} ref={ref} tabIndex={-1}>
      <div className="yp-viewer__bar">
        <span>
          {t('m.boards.position', locale, { index: new Intl.NumberFormat(locale).format(i + 1), total: new Intl.NumberFormat(locale).format(media.length) })}
        </span>
        <button type="button" onClick={onClose} aria-label={t('m.common.close', locale)}>
          <Icon name="x" />
        </button>
      </div>
      <div className="yp-viewer__stage">
        {m.kind === 'video' ? (
          <video
            key={m.id}
            src={videoSrc(m, saver)}
            poster={videoPoster(m, saver)}
            crossOrigin={videoCrossOrigin(m.captions)}
            controls
            autoPlay={!saver}
            preload={saver ? 'none' : undefined}
            playsInline
          >
            <CaptionTracks captions={m.captions} />
          </video>
        ) : m.kind === 'audio' ? (
          <audio src={m.url} controls />
        ) : (
          <img
            src={saver ? (m.variants?.medium ?? imageSrc(m)) : imageSrc(m)}
            alt={m.altText ?? ''}
            style={m.placeholder ? { backgroundImage: `url(${m.placeholder})`, backgroundSize: 'contain', backgroundRepeat: 'no-repeat' } : undefined}
          />
        )}
      </div>
      {media.length > 1 ? (
        <>
          <button type="button" className="yp-viewer__nav yp-viewer__nav--prev" onClick={() => go(-1)} aria-label={t('ds.previous', locale)}>
            <Icon name="chevron-left" />
          </button>
          <button type="button" className="yp-viewer__nav yp-viewer__nav--next" onClick={() => go(1)} aria-label={t('ds.next', locale)}>
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
  // Opens upward when there isn't room below (the last message in a chat, just above the message box).
  const [up, setUp] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  useLayoutEffect(() => {
    if (!open) return setUp(false);
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      const height = list.current?.offsetHeight ?? 0;
      if (!box) return;
      const below = window.innerHeight - box.bottom;
      setUp(below < height + 12 && box.top > below);
    };
    place();
    // The page can move while it's open (something appearing above the message box, the keyboard,
    // a scroll): check again each frame, which is cheap for the short time a menu is open.
    let frame = requestAnimationFrame(function again() {
      place();
      frame = requestAnimationFrame(again);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
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
        <ul ref={list} className={cx('yp-menu__list', up && 'yp-menu__list--up')} role="menu" id={listId} aria-label={label}>
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
  /** Show who reposted (where reposting isn't offered, e.g. on your own post, the count opens this). */
  onReposters?: (post: Post) => void;
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
  /** Change the text, audience or photo descriptions of your own post. */
  onEdit?: (post: Post) => void;
  /** Open the versions of an edited post's text (the "Edited" label). */
  onHistory?: (post: Post) => void;
}

type Person = Pick<PublicUser, 'id' | 'username' | 'displayName'>;

/** "Ada", "Ada and Bola" or "Ada, Bola and Chi" as plain text, in the reader's language. */
export function joinNames(people: Person[], locale = 'en'): string {
  return joinList(
    people.map((p) => p.displayName),
    locale,
  );
}

/** "Ada and Bola" (or "Ada, Bola and Chi"), each name linking to that profile. */
export function AuthorNames({
  people,
  linkAs: L = A,
  linkClassName,
  locale = 'en',
}: {
  people: Person[];
  linkAs?: LinkLike;
  linkClassName?: string;
  locale?: string;
}) {
  return (
    <>
      {people.map((p, i) => (
        <span key={p.id}>
          {i === 0 ? '' : i === people.length - 1 ? t('m.collab.joinLast', locale) : t('m.collab.joinSep', locale)}
          <L href={`/u/${p.username}`} className={linkClassName}>
            <bdi>{p.displayName}</bdi>
          </L>
        </span>
      ))}
    </>
  );
}

/** "Mon 6 Oct, 20:00": when a scheduled post goes out, in the reader's language and time zone. */
export function formatScheduled(iso: string, locale = 'en'): string {
  return new Date(iso).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The versions of an edited post's text, newest first. */
export function PostHistory({ versions, locale = 'en', linkAs }: { versions: PostVersion[]; locale?: string; linkAs?: LinkLike }) {
  return (
    <ol className="yp-history">
      {versions.map((v, i) => (
        <li key={`${v.at}-${i}`} className="yp-history__item">
          <p className="yp-history__when">
            {t(v.current ? 'm.post.historyNow' : 'm.post.historyEarlier', locale)} · <time dateTime={v.at}>{formatRelativeTime(v.at, locale)}</time>
          </p>
          <div className="yp-history__body" dir="auto">
            {v.body ? <TaggedText text={v.body} linkAs={linkAs} /> : <span className="yp-history__empty">{t('m.post.noText', locale)}</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The chip that is playing on the page: one at a time. */
let playingChip: HTMLAudioElement | null = null;

/**
 * Music on a post: the song's title and artist (opening its page), a button to play the part, and
 * the credit its licence asks for. It stays silent until tapped, so nothing is downloaded before
 * (Data saver or not), and stops when scrolled away. A song that can't play here says why, quietly.
 */
export function PostMusicChip({ music, locale = 'en', linkAs: L = A }: { music: PostMusic; locale?: string; linkAs?: LinkLike }) {
  const tt = (k: MessageKey, vars?: Vars) => tr(k, locale, vars);
  const [playing, setPlaying] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const start = music.startMs / 1000;
  const end = start + music.durationMs / 1000;
  const names = { title: music.title, artist: music.artist };

  // Stop when the post leaves the screen, and let go of the file when it goes away.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => {
      if (e && !e.isIntersecting) audio.current?.pause();
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(
    () => () => {
      const a = audio.current;
      if (!a) return;
      a.pause();
      a.removeAttribute('src');
      a.load();
      if (playingChip === a) playingChip = null;
    },
    [],
  );

  function toggle() {
    if (!music.audioUrl) return;
    let a = audio.current;
    if (!a) {
      // Made on the first tap: nothing loads before.
      a = new Audio();
      a.preload = 'auto';
      const toStart = () => {
        try {
          a!.currentTime = start;
        } catch {
          // Not seekable yet: loadedmetadata tries again.
        }
      };
      a.addEventListener('loadedmetadata', toStart);
      a.addEventListener('timeupdate', () => {
        if (a!.currentTime >= end - 0.05 || a!.currentTime < start - 0.5) toStart();
      });
      a.addEventListener('ended', () => {
        toStart();
        void a!.play().catch(() => {});
      });
      a.addEventListener('play', () => setPlaying(true));
      a.addEventListener('pause', () => setPlaying(false));
      a.src = music.audioUrl;
      audio.current = a;
    }
    if (a.paused) {
      if (playingChip && playingChip !== a) playingChip.pause();
      playingChip = a;
      void a.play().catch(() => setPlaying(false));
    } else a.pause();
  }

  const catalogue = music.source !== 'library';
  const credit = catalogue
    ? tt('music.credit', { title: music.title, artist: music.artist, licence: music.licenceName ?? '' }) +
      (music.attribution && !music.attribution.startsWith(music.title) ? ` · ${music.attribution}` : '')
    : tt('music.originalCredit', { artist: music.artist });
  return (
    <div className="yp-post__music" ref={box}>
      <div className="yp-post__music-chip">
        {music.audioUrl ? (
          <button
            type="button"
            className="yp-post__music-play"
            // The name says what pressing does (play or pause), so no aria-pressed as well.
            aria-label={tt(playing ? 'music.pauseOn' : 'music.playOn', names)}
            onClick={toggle}
          >
            <Icon name={playing ? 'pause' : 'play'} filled size={14} />
          </button>
        ) : (
          <span className="yp-post__music-play yp-post__music-play--off" aria-hidden>
            <Icon name="volume-off" size={14} />
          </span>
        )}
        <L
          href={catalogue ? `/music/${music.id}` : `/sounds/${music.id}`}
          className="yp-post__music-link"
          aria-label={tt('music.open', { title: music.title })}
        >
          <Icon name="music" size={14} />
          <bdi className="yp-post__music-title">{music.title}</bdi>
          <span aria-hidden>·</span>
          <bdi className="yp-post__music-artist">{music.artist}</bdi>
        </L>
        <span className={cx('yp-post__music-bars', playing && 'yp-post__music-bars--on')} aria-hidden>
          <span />
          <span />
          <span />
        </span>
      </div>
      {music.unavailable ? (
        <p className="yp-post__music-note">{tt(`music.unavailable.${music.unavailable}` as MessageKey)}</p>
      ) : (
        <p className="yp-post__music-credit">
          {music.licenceUrl ? (
            <a href={music.licenceUrl} target="_blank" rel="noopener noreferrer license">
              {credit}
            </a>
          ) : (
            credit
          )}
        </p>
      )}
    </div>
  );
}

/**
 * A mix's cover: a mosaic of the first four song covers (one cover fills it; none, or Data saver,
 * shows the mix symbol). Nothing loads on Data saver.
 */
export function MixMosaic({ covers, size = 64 }: { covers: string[]; size?: number }) {
  const saver = useDataSaver();
  const tiles = saver ? [] : covers.slice(0, 4);
  return (
    <span className={cx('yp-mix-mosaic', tiles.length >= 4 && 'yp-mix-mosaic--four')} style={{ width: size, height: size }} aria-hidden>
      {tiles.length === 0 ? (
        <Icon name="mix" size={Math.round(size / 2.4)} />
      ) : (
        (tiles.length >= 4 ? tiles : tiles.slice(0, 1)).map((url, i) => <img key={i} src={url} alt="" loading="lazy" decoding="async" />)
      )}
    </span>
  );
}

/**
 * A mix as a card (on a post that shares it, or in a chat): its mosaic, name, who made it and how
 * many songs, opening the mix. A mix the viewer can't see any more says so.
 */
export function MixTile({ mix, locale = 'en', linkAs: L = A, children }: { mix: MixCard; locale?: string; linkAs?: LinkLike; children?: ReactNode }) {
  if (!mix.available)
    return (
      <p className="yp-mix-tile yp-mix-tile--gone" role="note">
        <Icon name="mix" size={18} />
        <span>{tr('mixes.card.gone', locale)}</span>
      </p>
    );
  return (
    <div className="yp-mix-tile">
      <L href={`/mixes/${mix.id}`} className="yp-mix-tile__link" aria-label={tr('mixes.card.open', locale, { title: mix.title, name: mix.owner.displayName })}>
        <MixMosaic covers={mix.covers} />
        <span className="yp-mix-tile__text">
          <span className="yp-mix-tile__kind">
            <Icon name="mix" size={12} /> {tr('mixes.card.kind', locale)}
          </span>
          <bdi className="yp-mix-tile__title">{mix.title}</bdi>
          <span className="yp-mix-tile__meta">
            <bdi>{mix.owner.displayName}</bdi> · {trp('mixes.songs', mix.songCount, locale)}
          </span>
        </span>
      </L>
      {children}
    </div>
  );
}

/**
 * A question from someone's question box ("Ask me"), quoted: on the Answers tab above its answer,
 * and on a post that shares the answer. "Asked by @name" links to the asker; a question asked
 * without a name says so and never carries who asked.
 */
export function QuestionQuote({
  question,
  locale = 'en',
  linkAs: L = A,
  children,
}: {
  question: { question: string; askedWithoutName: boolean; asker: PublicUser | null };
  locale?: string;
  linkAs?: LinkLike;
  /** The answer, when it's shown inside the card. */
  children?: ReactNode;
}) {
  const by = question.askedWithoutName ? 'ask.card.askedWithoutName' : question.asker ? 'ask.card.askedBy' : 'ask.card.askedBySomeone';
  return (
    <figure className="yp-ask-quote">
      <blockquote className="yp-ask-quote__text" aria-label={t('ask.card.question', locale)}>
        <Icon name="help" size={16} />
        <bdi>{question.question}</bdi>
      </blockquote>
      <figcaption className="yp-ask-quote__by">
        {question.asker && !question.askedWithoutName ? (
          fill(t(by, locale), 'name', (at) => (
            <L href={`/u/${question.asker!.username}`}>
              <bdi>
                {at}
                {question.asker!.username}
              </bdi>
            </L>
          ))
        ) : (
          <span>{t(by, locale)}</span>
        )}
      </figcaption>
      {children}
    </figure>
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
  onReposters,
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
  onEdit,
  onHistory,
}: PostCardProps) {
  const tt = (k: MessageKey) => t(k, locale);
  // Why it's in your feed, in your language.
  const reason = postReasonText(post, { t: (k, vars) => tr(k, locale, vars) });
  /** "Like, 12": an action's name and its count, for screen readers. */
  const counted = (label: string, n: number) => `${label}${tt('m.collab.joinSep')}${new Intl.NumberFormat(locale).format(n)}`;
  const coauthors = post.collaborators ?? [];
  const pendingCoauthors = isOwn ? (post.pendingCollaborators ?? []) : [];
  // A co-author shares the post but only the original author can change or delete it.
  const coauthor = post.viewer.collab === 'accepted';
  const invited = post.viewer.collab === 'pending';
  const menu: MenuAction[] = [];
  const saveHold = useLongPress(onSaveTo ? () => onSaveTo(post) : undefined);
  if (onWhy) menu.push({ label: tt('post.why'), icon: 'info', onSelect: () => onWhy(post) });
  if (onSaveTo) menu.push({ label: tt('m.boards.saveTo'), icon: 'bookmark', onSelect: () => onSaveTo(post) });
  if (onAddToMemory) menu.push({ label: tt('post.addToMemory'), icon: 'bookmark', onSelect: () => onAddToMemory(post) });
  if (onLeaveCollab && coauthor && !isOwn) menu.push({ label: tt('m.collab.leave'), icon: 'logout', onSelect: () => onLeaveCollab(post) });
  if (onFeedback && !isOwn && !coauthor) {
    menu.push({ label: tt('post.moreLikeThis'), icon: 'plus', onSelect: () => onFeedback(post, 'more_like_this') });
    menu.push({ label: tt('post.lessLikeThis'), icon: 'eye', onSelect: () => onFeedback(post, 'less_like_this') });
    menu.push({ label: tt('post.notInterested'), icon: 'x', onSelect: () => onFeedback(post, 'not_interested') });
    menu.push({ label: tt('post.muteCreator'), icon: 'bell', onSelect: () => onFeedback(post, 'mute_creator') });
  }
  if (onReport && !isOwn && !coauthor) menu.push({ label: tt('post.report'), icon: 'flag', danger: true, onSelect: () => onReport(post) });
  if (onEdit && isOwn && !post.status) menu.push({ label: tt('m.post.edit'), icon: 'edit', onSelect: () => onEdit(post) });
  if (onPin && isOwn && !post.community) menu.push({ label: tt(post.pinned ? 'post.unpin' : 'post.pin'), icon: 'bookmark', onSelect: () => onPin(post) });
  if (onManageCollaborators && isOwn && !post.community)
    menu.push({
      label: tt(coauthors.length || pendingCoauthors.length ? 'post.coauthors' : 'm.collab.inviteTitle'),
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
  // Signed in, a reel is its poster frame: a tap opens it full screen in Reels, at this reel.
  const showReelCard = post.format === 'reel' && !!viewerId && !post.locked && post.media.length > 0;

  return (
    <article className="yp-post" aria-labelledby={`post-${post.id}-author`}>
      {post.pinned ? (
        <p className="yp-post__pinned">
          <Icon name="bookmark" size={12} filled />
          {tt('m.post.pinned')}
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
                <AuthorNames people={[post.author, ...coauthors]} linkAs={L} linkClassName="yp-post__name" locale={locale} />
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
            {post.status === 'scheduled' && post.scheduledAt ? (
              <span className="yp-post__state">
                {fill(tt('m.drafts.scheduledFor'), 'time', () => (
                  <time dateTime={post.scheduledAt!}>{formatScheduled(post.scheduledAt!, locale)}</time>
                ))}
              </span>
            ) : post.status === 'draft' ? (
              <span className="yp-post__state">{tt('m.drafts.draft')}</span>
            ) : (
              <bdi>
                <time dateTime={post.createdAt}>{formatRelativeTime(post.createdAt, locale)}</time>
              </bdi>
            )}
            {post.editedAt ? (
              <>
                {' · '}
                {onHistory ? (
                  <button type="button" className="yp-post__edited" onClick={() => onHistory(post)} aria-label={tt('post.editedA11y')}>
                    {tt('m.post.edited')}
                  </button>
                ) : (
                  <span>{tt('m.post.edited')}</span>
                )}
              </>
            ) : null}
            {post.community ? (
              <>
                {' · '}
                <L href={`/c/${post.community.slug}`}>{post.community.name}</L>
              </>
            ) : null}{' '}
            <Icon name={VIS_ICON[post.visibility] ?? 'globe'} size={12} label={t(`visibility.${post.visibility}` as MessageKey, locale)} />
            {/* Only the author gets the circle's name; people in it never see which circle. */}
            {post.circle ? <bdi className="yp-post__circle">{post.circle.name}</bdi> : null}
          </span>
        </div>
        {menu.length ? <Menu label={tt('post.options')} actions={menu} /> : null}
      </header>

      {invited && onAcceptCollab && onDeclineCollab ? (
        <div className="yp-post__invite" role="group" aria-label={tt('post.collabInviteGroup')}>
          <span>
            {fill(tt('post.collabInvited'), 'name', () => (
              <bdi>{post.author.displayName}</bdi>
            ))}
          </span>
          <span className="yp-post__invite-actions">
            <Button size="sm" onClick={() => onAcceptCollab(post)}>
              {tt('m.common.accept')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onDeclineCollab(post)}>
              {tt('m.common.decline')}
            </Button>
          </span>
        </div>
      ) : null}
      {pendingCoauthors.length ? (
        <p className="yp-post__reason yp-post__pending">
          <Icon name="users" size={14} />
          <span>{tr('m.collab.waiting', locale, { names: joinNames(pendingCoauthors, locale) })}</span>
        </p>
      ) : null}

      {post.question ? <QuestionQuote question={post.question} locale={locale} linkAs={L} /> : null}
      {post.body ? (
        <TranslatableText
          kind="post"
          id={post.id}
          text={post.body}
          lang={post.lang}
          own={isOwn || !!post.status}
          locale={locale}
          className="yp-post__body"
          render={(text) => <TaggedText text={text} linkAs={L} />}
        />
      ) : null}

      {post.locked ? <LockedPanel post={post} locale={locale} linkAs={L} /> : null}
      {post.remixOf || post.sound ? (
        <p className="yp-post__reel">
          {post.remixOf ? (
            post.remixOf.post ? (
              <L href={`/reels?start=${post.remixOf.post.id}`} className="yp-post__reel-link">
                <Icon name="duet" size={14} />
                <span>
                  {fill(tt(post.remixOf.mode === 'duet' ? 'm.reels.duetWith' : 'm.reels.remixOf'), 'name', (at) => (
                    <bdi>
                      {at}
                      {post.remixOf!.post!.author.username}
                    </bdi>
                  ))}
                </span>
              </L>
            ) : (
              <span className="yp-post__reel-link">
                <Icon name="duet" size={14} />
                {tt(post.remixOf.mode === 'duet' ? 'post.duetUnavailable' : 'post.remixUnavailable')}
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

      {post.music ? <PostMusicChip music={post.music} locale={locale} linkAs={L} /> : null}
      {post.mix ? (
        <div className="yp-post__mix">
          <MixTile mix={post.mix} locale={locale} linkAs={L} />
        </div>
      ) : null}

      {post.poll ? (
        <div className="yp-poll" role="group" aria-label={tt('m.sticker.kind.poll')}>
          {post.poll.options.map((o) => {
            const pct = totalVotes ? Math.round((o.votes / totalVotes) * 100) : 0;
            return (
              <button key={o.id} type="button" aria-pressed={post.poll!.myVote === o.id} onClick={() => onVote?.(post, o.id)}>
                <span className="yp-poll__bar" style={{ width: post.poll!.myVote ? `${pct}%` : 0 }} aria-hidden />
                <span>{o.label}</span>
                {post.poll!.myVote ? <span>{new Intl.NumberFormat(locale, { style: 'percent' }).format(pct / 100)}</span> : null}
              </button>
            );
          })}
          <span className="yp-post__meta">{trp('m.poll.votes', totalVotes, locale)}</span>
        </div>
      ) : null}

      {showReelCard ? (
        <ReelCard post={post} locale={locale} linkAs={L} />
      ) : post.media.length ? (
        <div className="yp-post__media">
          <MediaGrid
            media={post.media}
            tagOptions={{
              linkAs: L,
              viewerId,
              canRemoveAny: isOwn,
              onRemoveTag: onRemoveTag ? (mediaId, tag) => onRemoveTag(post, mediaId, tag) : undefined,
            }}
            locale={locale}
          />
        </div>
      ) : null}

      {(post.format === 'reel' && !showReelCard) || post.linkUrl || post.event || post.product || chipTopics.length ? (
        <div className="yp-post__chips">
          {post.format === 'reel' && !showReelCard ? (
            <L href={`/reels?start=${post.id}`} className="yp-chip">
              <Icon name="sparkle" />
              {tt('post.reelWatch')}
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
          {t('post.withheld', locale, {
            regions: joinList(
              post.withheldIn.map((c) => regionName(c, locale)),
              locale,
            ),
          })}
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

      {reason || post.aiAssisted || post.real ? (
        <div className="yp-post__reason">
          {reason ? (
            <>
              <Icon name="info" size={14} />
              {reason}
            </>
          ) : null}
          {post.aiAssisted ? <Badge tone="neutral">{tt('post.aiAssisted')}</Badge> : null}
          {post.real ? (
            <Badge tone="success">
              {t('post.realCaptured', locale, { time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(post.real.capturedAt)) })}
            </Badge>
          ) : null}
        </div>
      ) : null}

      {/* Drafts and scheduled posts can't be liked, commented on or shared yet. */}
      {post.status ? null : (
        <div className="yp-post__actions">
          <button
            type="button"
            className="yp-action"
            aria-pressed={post.viewer.liked}
            onClick={() => onLike?.(post)}
            aria-label={counted(post.viewer.liked ? tt('post.unlike') : tt('post.like'), post.counts.likes)}
          >
            <Icon name="heart" filled={post.viewer.liked} />
            {post.counts.likes || ''}
          </button>
          <button type="button" className="yp-action" onClick={() => onComment?.(post)} aria-label={counted(tt('post.comments'), post.counts.comments)}>
            <Icon name="message" />
            {post.counts.comments || ''}
          </button>
          {onRepost && !isOwn && !coauthor && post.visibility === 'public' ? (
            <button
              type="button"
              className={cx('yp-action', post.viewer.reposted && 'yp-action--reposted')}
              aria-pressed={post.viewer.reposted}
              onClick={() => onRepost(post)}
              // A toggle: aria-pressed says whether you reposted it, so the name stays the same.
              aria-label={counted(tt('m.reels.repost'), post.counts.reposts)}
            >
              <Icon name="repost" />
              {post.counts.reposts || ''}
            </button>
          ) : post.counts.reposts && onReposters ? (
            <button
              type="button"
              className="yp-action"
              onClick={() => onReposters(post)}
              aria-label={counted(tt('post.reposts'), post.counts.reposts)}
              aria-haspopup="dialog"
            >
              <Icon name="repost" />
              {post.counts.reposts}
            </button>
          ) : post.counts.reposts ? (
            <span className="yp-action yp-action--static" aria-label={counted(tt('post.reposts'), post.counts.reposts)}>
              <Icon name="repost" />
              {post.counts.reposts}
            </span>
          ) : null}
          {onShare && post.visibility !== 'private' ? (
            <button type="button" className="yp-action" onClick={() => onShare(post)} aria-label={tt('m.common.share')}>
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
      )}
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
 * A reel in a feed, a profile or a tag page: its poster frame with a play sign and "Watch reel",
 * one link that opens the full-screen viewer at this reel (Back returns here).
 */
function ReelCard({ post, locale, linkAs: L }: { post: Post; locale: string; linkAs: LinkLike }) {
  const saver = useDataSaver();
  const m = post.media.find((x) => x.kind === 'video') ?? post.media[0]!;
  const poster = videoPoster(m, saver) ?? m.placeholder ?? undefined;
  const ratio = m.width && m.height ? m.width / m.height : 9 / 16;
  return (
    <L
      href={`/reels?start=${post.id}`}
      className={cx('yp-post__reel-card', ratio > 1.2 ? 'yp-post__reel-card--wide' : ratio > 0.85 && 'yp-post__reel-card--square')}
      aria-label={t('reel.card.label', locale, { name: post.author.displayName })}
    >
      {poster ? <img src={poster} alt="" loading="lazy" className={m.sensitive ? 'yp-blurred' : undefined} /> : null}
      <span className="yp-post__reel-play" aria-hidden>
        <Icon name="play" size={24} filled />
      </span>
      <span className="yp-post__reel-watch" aria-hidden>
        <Icon name="sparkle" size={14} />
        {t('reel.card.watch', locale)}
      </span>
    </L>
  );
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

export function ChatBubble({
  mine,
  sender,
  body,
  time,
  pending,
  locale = 'en',
}: {
  mine: boolean;
  sender?: string;
  body: ReactNode;
  time?: string;
  pending?: boolean;
  locale?: string;
}) {
  return (
    <div className={cx('yp-bubble', mine ? 'yp-bubble--me' : 'yp-bubble--them', pending && 'yp-bubble--pending')}>
      {sender && !mine ? <bdi className="yp-bubble__sender">{sender}</bdi> : null}
      <span dir="auto">{body}</span>
      {time ? <span className="yp-bubble__time">{pending ? t('ds.sending', locale) : time}</span> : null}
    </div>
  );
}

export function CommunityCard({
  community,
  href,
  linkAs: L = A,
  action,
  locale = 'en',
}: {
  community: { name: string; description: string; memberCount: number; visibility?: string; topics?: string[] };
  href: string;
  linkAs?: LinkLike;
  action?: ReactNode;
  locale?: string;
}) {
  return (
    <div className="yp-ccard">
      <L href={href} className="yp-ccard__mark" aria-label={community.name}>
        {initialsOf(community.name, 1)}
      </L>
      <L href={href}>
        <h3 className="yp-ccard__title">{community.name}</h3>
      </L>
      {community.description ? <p className="yp-ccard__desc">{community.description}</p> : null}
      <span className="yp-ccard__meta">
        {trp('m.community.members', community.memberCount, locale)}
        {community.visibility === 'private' ? ` · ${t('m.community.private', locale)}` : ''}
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
          {event.online ? t('ds.online', locale) : (event.place?.name ?? event.locationText ?? t('ds.locationTba', locale))} ·{' '}
          {trp('ds.event.going', event.counts.going, locale)}
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
      {product.inventory !== null ? (
        <span className="yp-pcard__stock">{product.inventory > 0 ? trp('ds.product.left', product.inventory, locale) : t('ds.product.soldOut', locale)}</span>
      ) : null}
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
  locale = 'en',
}: {
  locale?: string;
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
  const yours = t('m.stories.yours', locale);
  return (
    <ul className="yp-moments" aria-label={t('m.stories.label', locale)}>
      {onCreate && !hasOwn ? (
        <li>
          <button type="button" className="yp-moment" onClick={onCreate}>
            <span className="yp-avatar yp-avatar--lg" style={{ background: 'var(--surface-sunken)', color: 'var(--yapi)' }} aria-hidden>
              <Icon name="plus" />
            </span>
            <span className="yp-moment__name">{yours}</span>
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
              aria-label={[
                g.mine ? yours : g.author.displayName,
                trp('ds.stories.count', g.moments.length, locale),
                t(g.allSeen ? 'ds.stories.seen' : 'ds.stories.new', locale),
                ...(close ? [t('ds.stories.closeFriends', locale)] : []),
              ].join(t('m.collab.joinSep', locale))}
            >
              <span className={close ? 'yp-moment__ring yp-moment__ring--close' : g.allSeen ? 'yp-moment__ring yp-moment__ring--seen' : 'yp-moment__ring'}>
                <Avatar name={g.author.displayName} src={g.author.avatarUrl} size="lg" />
              </span>
              <span className="yp-moment__name">
                <bdi>{g.mine ? yours : g.author.displayName}</bdi>
              </span>
            </button>
            {g.mine && onCreate ? (
              <button type="button" className="yp-moment__add" onClick={onCreate} aria-label={t('m.stories.add', locale)}>
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
  label,
  children,
  notice,
  actions,
  loading,
}: {
  title: string;
  /** A mark such as "AI-generated", shown next to the title. */
  label?: string;
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
        {label ? <span className="yp-ai__label">{label}</span> : null}
      </div>
      {loading ? <div className="yp-skeleton" style={{ height: 40 }} /> : <div className="yp-ai__body">{children}</div>}
      {notice ? <div className="yp-ai__notice">{notice}</div> : null}
      {actions ? <div className="yp-ai__actions">{actions}</div> : null}
    </section>
  );
}

/**
 * Nothing to show, or something that couldn't load. `level` 1 when it is all the page shows (a
 * missing or failed page), so the page still has its one `h1`; 2 (the default) inside a page.
 */
export function EmptyState({ title, body, action, level = 2 }: { title: string; body?: string; action?: ReactNode; level?: 1 | 2 | 3 }) {
  const Heading = `h${level}` as 'h1' | 'h2' | 'h3';
  return (
    <div className="yp-empty">
      <Heading className="yp-empty__title">{title}</Heading>
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
 * The live region is always on the page and only its content changes, so screen readers announce
 * each message (a region added together with its text is often missed). Pass a new `id` for each
 * toast, so the same text twice is shown (and timed) twice.
 */
export function Toast({
  message,
  onDone,
  ms,
  action,
  id,
}: {
  message: string | null;
  onDone: () => void;
  ms?: number;
  action?: ToastAction | null;
  id?: number | string;
}) {
  const [held, setHeld] = useState(false);
  const wait = ms ?? (action ? 6000 : 3000);
  useEffect(() => {
    if (!message || held) return;
    const timer = setTimeout(onDone, wait);
    return () => clearTimeout(timer);
  }, [message, wait, onDone, held, action, id]);
  useEffect(() => {
    setHeld(false);
  }, [message, id]);
  return (
    <div className="yp-toast-region" role="status" aria-live="polite" aria-atomic="true">
      {message ? (
        <div
          key={id}
          className={cx('yp-toast', action && 'yp-toast--action')}
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
      ) : null}
    </div>
  );
}

export { Button };

function regionName(code: string, locale?: string): string {
  try {
    return new Intl.DisplayNames([locale ?? 'en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}
