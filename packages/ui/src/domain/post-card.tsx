import { useState, type ReactNode } from 'react';
import { Avatar } from '../components/avatar';
import { Badge, Button, Card, IconButton } from '../components/primitives';
import { Menu, type MenuItemDef } from '../components/menu';
import {
  BookmarkIcon,
  CommentIcon,
  EyeOffIcon,
  GlobeIcon,
  HeartIcon,
  LinkIcon,
  LockIcon,
  MoreIcon,
  ShareIcon,
  ThumbDownIcon,
  UserIcon,
  UsersIcon,
  SparkIcon,
  BanIcon,
  PinIcon,
  CloseIcon,
} from '../components/icons';
import { useLowBandwidth, useUI } from '../context';
import { formatCompact, formatDateTime, formatRelativeTime } from '../format';
import { cx } from '../utils';
import { PollView, type PollLabels } from './poll-view';
import { ReasonsPopover, type ReasonsLabels } from './reasons-popover';
import { RichText } from './rich-text';
import type { FeedbackAction, PostData, ReactionType, VisibilityKind } from './types';

export interface PostCardLabels {
  like: string;
  save: string;
  comment: string;
  share: string;
  shareOnlyPublic: string;
  moreMenu: string;
  reactionMenu: string;
  reactions: Record<ReactionType, string>;
  visibility: Record<VisibilityKind, string>;
  edited: string;
  likesCount: (n: number) => string;
  commentsCount: (n: number) => string;
  authorLink: (name: string) => string;
  topics: string;
  moreLikeThis: string;
  lessLikeThis: string;
  notInterested: string;
  muteCreator: (username: string) => string;
  muteTopic: (topic: string) => string;
  linkPreview: string;
  loadMedia: string;
  mediaHiddenLowBandwidth: string;
  poll: PollLabels;
  reasons: ReasonsLabels;
}

export interface PostCardProps {
  post: PostData;
  labels: PostCardLabels;
  /** Link to the post detail page. When set the timestamp and comment button link there. */
  href?: string;
  profileHref?: string;
  /** Level of the (visually hidden) heading naming the post for screen-reader heading navigation. */
  onReact?: (kind: ReactionType | null) => void | Promise<void>;
  onSave?: (saved: boolean) => void | Promise<void>;
  onShare?: () => void | Promise<void>;
  onVote?: (optionIds: string[]) => Promise<void>;
  onFeedback?: (a: FeedbackAction) => Promise<void> | void;
  /** Fetch localised reasons for "Why am I seeing this?". Omit to hide the control. */
  loadReasons?: () => Promise<string[]>;
  /** Extra menu items (e.g. delete for the author). */
  menuItems?: MenuItemDef[];
  /** Hide the feedback menu entries (e.g. on your own posts). */
  hideFeedback?: boolean;
  headingLevel?: 2 | 3;
  now?: number;
  /** Detail view shows the whole thing without truncation. */
  detail?: boolean;
  className?: string;
  children?: ReactNode;
}

const VIS_ICON: Record<VisibilityKind, typeof GlobeIcon> = {
  public: GlobeIcon,
  followers: UsersIcon,
  friends: UsersIcon,
  circle: UsersIcon,
  selected: UserIcon,
  private: LockIcon,
  community: PinIcon,
};
const REACTION_ORDER: ReactionType[] = ['like', 'love', 'laugh', 'wow', 'sad', 'insightful'];
const EMOJI: Record<ReactionType, string> = {
  like: '👍',
  love: '❤️',
  laugh: '😄',
  wow: '😮',
  sad: '😢',
  insightful: '💡',
};

export function PostCard(props: PostCardProps) {
  const {
    post,
    labels,
    href,
    profileHref,
    onReact,
    onSave,
    onShare,
    onVote,
    onFeedback,
    loadReasons,
    menuItems = [],
    hideFeedback,
    headingLevel = 3,
    now,
    detail,
    className,
    children,
  } = props;
  const { Link, locale } = useUI();
  const [busy, setBusy] = useState(false);
  const isOwn = post.viewer.isAuthor;
  const VisIcon = VIS_ICON[post.visibility];
  const reacted = post.viewer.reaction !== null;
  const canShare = post.visibility === 'public';
  const H = `h${headingLevel}` as 'h3';

  const guard = async (fn: () => void | Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const feedbackItems: MenuItemDef[] =
    !hideFeedback && onFeedback && !isOwn
      ? [
          {
            id: 'more',
            label: labels.moreLikeThis,
            icon: <SparkIcon size={16} />,
            onSelect: () => void onFeedback({ type: 'more_like_this' }),
          },
          {
            id: 'less',
            label: labels.lessLikeThis,
            icon: <ThumbDownIcon size={16} />,
            onSelect: () => void onFeedback({ type: 'less_like_this' }),
          },
          {
            id: 'ni',
            label: labels.notInterested,
            icon: <CloseIcon size={16} />,
            onSelect: () => void onFeedback({ type: 'not_interested' }),
          },
          {
            id: 'mute',
            label: labels.muteCreator(post.author.username),
            icon: <EyeOffIcon size={16} />,
            onSelect: () => void onFeedback({ type: 'mute_creator' }),
            separatorBefore: true,
          },
          ...post.topics.slice(0, 3).map((t): MenuItemDef => ({
            id: `topic-${t}`,
            label: labels.muteTopic(t),
            icon: <BanIcon size={16} />,
            onSelect: () => void onFeedback({ type: 'mute_topic', topic: t }),
          })),
        ]
      : [];
  const allMenu = [
    ...feedbackItems,
    ...menuItems.map((m, i) =>
      i === 0 && feedbackItems.length ? { ...m, separatorBefore: true } : m,
    ),
  ];

  const time = (
    <time dateTime={post.createdAt} title={formatDateTime(post.createdAt, locale)}>
      {formatRelativeTime(post.createdAt, locale, now)}
    </time>
  );
  const profileLink = profileHref ?? `/u/${post.author.username}`;

  return (
    <Card
      as="article"
      padding="none"
      className={cx('yl-post', className)}
      aria-labelledby={`post-${post.id}-h`}
      data-post-id={post.id}
    >
      <header className="yl-post__head">
        <Link
          href={profileLink}
          className="yl-post__avatar-link"
          aria-label={labels.authorLink(post.author.displayName)}
          tabIndex={-1}
        >
          <Avatar name={post.author.displayName} src={post.author.avatarUrl} decorative />
        </Link>
        <div className="yl-post__who">
          <H id={`post-${post.id}-h`} className="yl-post__name">
            <Link href={profileLink} className="yl-post__name-link">
              {post.author.displayName}
            </Link>
          </H>
          <p className="yl-post__meta">
            <span className="yl-post__handle" dir="ltr">
              @{post.author.username}
            </span>
            <span aria-hidden="true">·</span>
            {href ? (
              <Link href={href} className="yl-post__time-link">
                {time}
              </Link>
            ) : (
              time
            )}
            {post.editedAt ? <span className="yl-post__edited">({labels.edited})</span> : null}
            <span aria-hidden="true">·</span>
            <Badge tone="neutral" icon={<VisIcon size={12} />} className="yl-post__vis">
              {labels.visibility[post.visibility]}
            </Badge>
          </p>
        </div>
        {allMenu.length ? (
          <Menu
            label={labels.moreMenu}
            items={allMenu}
            trigger={<IconButton label={labels.moreMenu} icon={<MoreIcon />} size="sm" />}
          />
        ) : null}
      </header>

      {post.body ? (
        <div className={cx('yl-post__body', !detail && 'yl-post__body--clamp')}>
          <RichText text={post.body} />
        </div>
      ) : null}

      {post.link ? <LinkPreview url={post.link.url} label={labels.linkPreview} /> : null}
      {post.media.length ? <MediaGrid media={post.media} labels={labels} /> : null}
      {post.poll ? (
        <PollView
          poll={post.poll}
          labels={labels.poll}
          onVote={onVote ?? (async () => undefined)}
          now={now}
          className="yl-post__poll"
        />
      ) : null}

      {post.topics.length ? (
        <ul className="yl-post__topics" aria-label={labels.topics}>
          {post.topics.map((t) => (
            <li key={t}>
              <Badge tone="secondary">{t}</Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {children}

      <footer className="yl-post__actions">
        <div className="yl-post__action-group">
          <button
            type="button"
            className={cx('yl-action', reacted && 'is-active')}
            aria-pressed={reacted}
            aria-label={`${labels.like}, ${labels.likesCount(post.counts.likes)}`}
            disabled={!onReact || busy}
            onClick={() => void guard(() => onReact?.(reacted ? null : 'like'))}
            data-testid="like-button"
          >
            <HeartIcon className={cx(reacted && 'yl-icon--filled')} />
            <span className="yl-action__count" aria-hidden="true">
              {formatCompact(post.counts.likes, locale)}
            </span>
          </button>
          {onReact ? (
            <Menu
              label={labels.reactionMenu}
              align="start"
              trigger={
                <button
                  type="button"
                  className="yl-action yl-action--mini"
                  aria-label={labels.reactionMenu}
                >
                  {reacted && post.viewer.reaction ? EMOJI[post.viewer.reaction] : '☺'}
                </button>
              }
              items={REACTION_ORDER.map((k) => ({
                id: k,
                label: labels.reactions[k],
                icon: <span aria-hidden="true">{EMOJI[k]}</span>,
                checked: post.viewer.reaction === k,
                onSelect: () => void guard(() => onReact(k)),
              }))}
            />
          ) : null}
          {href ? (
            <Link
              href={href}
              className="yl-action"
              aria-label={`${labels.comment}, ${labels.commentsCount(post.counts.comments)}`}
              data-testid="comment-link"
            >
              <CommentIcon />
              <span className="yl-action__count" aria-hidden="true">
                {formatCompact(post.counts.comments, locale)}
              </span>
            </Link>
          ) : (
            <span className="yl-action yl-action--static">
              <CommentIcon />
              <span className="yl-sr-only">{labels.commentsCount(post.counts.comments)}</span>
              <span className="yl-action__count" aria-hidden="true">
                {formatCompact(post.counts.comments, locale)}
              </span>
            </span>
          )}
          <button
            type="button"
            className={cx('yl-action', post.viewer.saved && 'is-active')}
            aria-pressed={post.viewer.saved}
            aria-label={labels.save}
            disabled={!onSave || busy}
            onClick={() => void guard(() => onSave?.(!post.viewer.saved))}
            data-testid="save-button"
          >
            <BookmarkIcon className={cx(post.viewer.saved && 'yl-icon--filled')} />
          </button>
          <button
            type="button"
            className="yl-action"
            aria-label={canShare ? labels.share : `${labels.share}. ${labels.shareOnlyPublic}`}
            aria-disabled={!canShare || !onShare || undefined}
            title={canShare ? labels.share : labels.shareOnlyPublic}
            onClick={() => {
              if (canShare && onShare) void guard(onShare);
            }}
            data-testid="share-button"
          >
            <ShareIcon />
          </button>
        </div>
        {loadReasons ? (
          <ReasonsPopoverSlot
            post={post}
            labels={labels}
            loadReasons={loadReasons}
            onFeedback={onFeedback}
          />
        ) : null}
      </footer>
    </Card>
  );
}

function ReasonsPopoverSlot({
  post,
  labels,
  loadReasons,
  onFeedback,
}: {
  post: PostData;
  labels: PostCardLabels;
  loadReasons: () => Promise<string[]>;
  onFeedback: PostCardProps['onFeedback'];
}) {
  return (
    <ReasonsPopover
      postId={post.id}
      labels={labels.reasons}
      load={loadReasons}
      {...(onFeedback ? { onFeedback } : {})}
    />
  );
}

function LinkPreview({ url, label }: { url: string; label: string }) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    /* keep raw */
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      className="yl-linkcard"
      dir="ltr"
    >
      <LinkIcon size={18} />
      <span className="yl-linkcard__text">
        <span className="yl-sr-only">{label}: </span>
        <span className="yl-linkcard__host">{host}</span>
        <span className="yl-linkcard__url">{url}</span>
      </span>
    </a>
  );
}

function MediaGrid({ media, labels }: { media: PostData['media']; labels: PostCardLabels }) {
  const lowBw = useLowBandwidth();
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  return (
    <div className={cx('yl-media', `yl-media--${Math.min(media.length, 4)}`)}>
      {media.map((m) => {
        const show = !lowBw || loaded[m.id];
        return (
          <div key={m.id} className="yl-media__item">
            {show ? (
              m.kind === 'video' ? (
                <video
                  src={m.url}
                  controls
                  preload="none"
                  className="yl-media__el"
                  aria-label={m.altText ?? undefined}
                />
              ) : m.kind === 'audio' ? (
                <audio
                  src={m.url}
                  controls
                  preload="none"
                  className="yl-media__audio"
                  aria-label={m.altText ?? undefined}
                />
              ) : (
                <img
                  src={m.url}
                  alt={m.altText ?? ''}
                  loading="lazy"
                  decoding="async"
                  className="yl-media__el"
                />
              )
            ) : (
              <div className="yl-media__placeholder">
                <p>{labels.mediaHiddenLowBandwidth}</p>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setLoaded((l) => ({ ...l, [m.id]: true }))}
                >
                  {labels.loadMedia}
                </Button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
