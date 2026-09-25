import { useId, useRef, useState, type FormEvent } from 'react';
import { Avatar } from '../components/avatar';
import { Button } from '../components/primitives';
import { Textarea, FormField } from '../components/form';
import { HeartIcon, TrashIcon } from '../components/icons';
import { useUI } from '../context';
import { formatCompact, formatDateTime, formatRelativeTime } from '../format';
import { cx } from '../utils';
import { RichText } from './rich-text';
import type { CommentData } from './types';

export interface CommentNode extends CommentData {
  replies?: CommentData[];
  repliesLoading?: boolean;
  repliesHasMore?: boolean;
}

export interface CommentLabels {
  heading: string;
  empty: string;
  placeholder: string;
  submit: string;
  submitting: string;
  reply: string;
  replyTo: (name: string) => string;
  cancel: string;
  like: string;
  likesCount: (n: number) => string;
  delete: string;
  deleteAria: (name: string) => string;
  showReplies: (n: number) => string;
  hideReplies: string;
  moreReplies: string;
  loadMore: string;
  loading: string;
  pending: string;
  edited: string;
  commentLabel: string;
  tooLong: string;
  repliesGroup: (name: string) => string;
}

export interface CommentThreadProps {
  comments: CommentNode[];
  labels: CommentLabels;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onSubmit: (body: string, parentId?: string) => Promise<void>;
  onLoadReplies: (commentId: string) => void;
  onReact: (comment: CommentData, reacted: boolean) => void | Promise<void>;
  onDelete?: (comment: CommentData) => void | Promise<void>;
  /** Owner of the post may delete any comment. */
  canModerate?: boolean;
  now?: number;
  /** Headings level for the section title. */
  headingLevel?: 2 | 3;
}

const MAX = 4000;

export function CommentForm({
  labels,
  onSubmit,
  parentId,
  autoFocus,
  onDone,
  ariaLabel,
}: {
  labels: CommentLabels;
  onSubmit: CommentThreadProps['onSubmit'];
  parentId?: string;
  autoFocus?: boolean;
  onDone?: () => void;
  ariaLabel: string;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = body.trim();
    if (!text || busy) return;
    if (text.length > MAX) {
      setError(labels.tooLong);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text, parentId);
      setBody('');
      onDone?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="yl-commentform" onSubmit={(e) => void submit(e)}>
      <FormField label={ariaLabel} hideLabel error={error}>
        <Textarea
          ref={ref}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={labels.placeholder}
          rows={2}
          maxLength={MAX + 200}
          autoFocus={autoFocus}
        />
      </FormField>
      <div className="yl-commentform__actions">
        {onDone ? (
          <Button size="sm" variant="ghost" onClick={onDone}>
            {labels.cancel}
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          loading={busy}
          loadingLabel={labels.submitting}
          disabled={!body.trim()}
        >
          {labels.submit}
        </Button>
      </div>
    </form>
  );
}

function CommentItem({
  c,
  labels,
  isReply,
  props,
}: {
  c: CommentNode | CommentData;
  labels: CommentLabels;
  isReply: boolean;
  props: CommentThreadProps;
}) {
  const { locale, Link } = useUI();
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const node = c as CommentNode;
  const reacted = c.viewer.reaction !== null;
  const repliesId = useId();
  const canDelete = c.viewer.isAuthor || props.canModerate;
  const parentIdForReply = c.parentId ?? c.id;

  return (
    <li className={cx('yl-comment', isReply && 'yl-comment--reply')} id={`comment-${c.id}`}>
      <Avatar name={c.author.displayName} src={c.author.avatarUrl} size="sm" decorative />
      <div className="yl-comment__main">
        <p className="yl-comment__head">
          <Link href={`/u/${c.author.username}`} className="yl-comment__name">
            {c.author.displayName}
          </Link>
          <span className="yl-comment__handle" dir="ltr">
            @{c.author.username}
          </span>
          <time
            dateTime={c.createdAt}
            title={formatDateTime(c.createdAt, locale)}
            className="yl-comment__time"
          >
            {formatRelativeTime(c.createdAt, locale, props.now)}
          </time>
          {c.editedAt ? <span className="yl-comment__time">({labels.edited})</span> : null}
        </p>
        {c.pendingApproval ? <p className="yl-comment__pending">{labels.pending}</p> : null}
        <div className="yl-comment__body">
          <RichText text={c.body} />
        </div>
        <div className="yl-comment__actions">
          <button
            type="button"
            className={cx('yl-action yl-action--sm', reacted && 'is-active')}
            aria-pressed={reacted}
            aria-label={`${labels.like}, ${labels.likesCount(c.counts.likes)}`}
            onClick={() => void props.onReact(c, !reacted)}
          >
            <HeartIcon size={16} className={cx(reacted && 'yl-icon--filled')} />
            <span aria-hidden="true">{formatCompact(c.counts.likes, locale)}</span>
          </button>
          <button
            type="button"
            className="yl-action yl-action--sm"
            aria-expanded={replying}
            onClick={() => setReplying((r) => !r)}
          >
            {labels.reply}
          </button>
          {canDelete && props.onDelete ? (
            <button
              type="button"
              className="yl-action yl-action--sm yl-action--danger"
              aria-label={labels.deleteAria(c.author.displayName)}
              onClick={() => void props.onDelete?.(c)}
            >
              <TrashIcon size={16} />
              <span>{labels.delete}</span>
            </button>
          ) : null}
        </div>
        {replying ? (
          <CommentForm
            labels={labels}
            ariaLabel={labels.replyTo(c.author.displayName)}
            parentId={parentIdForReply}
            autoFocus
            onSubmit={async (b, p) => {
              await props.onSubmit(b, p);
              setExpanded(true);
              if (!isReply) props.onLoadReplies(c.id);
            }}
            onDone={() => setReplying(false)}
          />
        ) : null}
        {!isReply && (node.counts.replies > 0 || (node.replies?.length ?? 0) > 0) ? (
          <div className="yl-comment__replies">
            <button
              type="button"
              className="yl-action yl-action--sm"
              aria-expanded={expanded}
              aria-controls={repliesId}
              onClick={() => {
                const next = !expanded;
                setExpanded(next);
                if (next && !node.replies) props.onLoadReplies(c.id);
              }}
            >
              {expanded ? labels.hideReplies : labels.showReplies(node.counts.replies)}
            </button>
            <div id={repliesId} hidden={!expanded}>
              {expanded ? (
                <>
                  <ul
                    className="yl-comment__list"
                    aria-label={labels.repliesGroup(c.author.displayName)}
                  >
                    {(node.replies ?? []).map((r) => (
                      <CommentItem key={r.id} c={r} labels={labels} isReply props={props} />
                    ))}
                  </ul>
                  {node.repliesLoading ? (
                    <p className="yl-comment__loading" role="status">
                      {labels.loading}
                    </p>
                  ) : null}
                  {node.repliesHasMore && !node.repliesLoading ? (
                    <Button size="sm" variant="ghost" onClick={() => props.onLoadReplies(c.id)}>
                      {labels.moreReplies}
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export function CommentThread(props: CommentThreadProps) {
  const { comments, labels, hasMore, loadingMore, onLoadMore, onSubmit, headingLevel = 2 } = props;
  const H = `h${headingLevel}` as 'h2';
  return (
    <section className="yl-comments" aria-labelledby="comments-heading">
      <H id="comments-heading" className="yl-comments__title">
        {labels.heading}
      </H>
      <CommentForm labels={labels} onSubmit={onSubmit} ariaLabel={labels.commentLabel} />
      {comments.length === 0 ? (
        <p className="yl-comments__empty">{labels.empty}</p>
      ) : (
        <ul className="yl-comment__list">
          {comments.map((c) => (
            <CommentItem key={c.id} c={c} labels={labels} isReply={false} props={props} />
          ))}
        </ul>
      )}
      {hasMore ? (
        <div className="yl-comments__more">
          <Button
            variant="secondary"
            loading={loadingMore}
            loadingLabel={labels.loading}
            onClick={onLoadMore}
          >
            {labels.loadMore}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
