'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Menu,
  QuestionQuote,
  Segments,
  Select,
  Skeleton,
  TextField,
  type MenuAction,
} from '@yapilapi/design-system';
import {
  noticeText,
  ASK_ANSWER_MAX,
  ASK_FILTERS,
  ASK_SHARE_VISIBILITIES,
  formatRelativeTime,
  type AskBoxSettings,
  type AskFilter,
  type AskShareVisibility,
  type InboxQuestion,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { ReportSheet } from '@/components/PostList';
import { useRealtime, useSession } from '../../providers';

const FILTER_LABEL: Record<AskFilter, MessageKey> = { new: 'ask.inbox.new', answered: 'ask.inbox.answered', hidden: 'ask.inbox.hidden' };
const EMPTY: Record<AskFilter, MessageKey> = { new: 'ask.inbox.empty.new', answered: 'ask.inbox.empty.answered', hidden: 'ask.inbox.empty.hidden' };

/**
 * Questions people asked you: new, answered and hidden. Answer (and share the answer as a post),
 * hide, delete, report or block whoever asked. Questions asked without a name never say who asked,
 * here either; blocking from one stops that person asking again without telling you who it is.
 */
export default function QuestionsPage() {
  const { t, toast, locale } = useSession();
  const [filter, setFilter] = useState<AskFilter>('new');
  const [items, setItems] = useState<InboxQuestion[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<AskFilter, number> | null>(null);
  const [box, setBox] = useState<AskBoxSettings | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const [reporting, setReporting] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(
    async (next?: string) => {
      try {
        const page = await api.questions.inbox(filter, next);
        setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
        setCounts(page.counts);
      } catch (e) {
        setItems((cur) => cur ?? []);
        toast(errorMessage(e));
      }
    },
    [filter, toast],
  );
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);
  useEffect(() => {
    api.questions.box().then(
      (r) => setBox(r.box),
      () => {},
    );
    document.title = `${t('ask.title')} · YAPILAPI`;
  }, [t]);
  // A new question while the page is open.
  useRealtime((e) => e.type === 'question.received' && filter === 'new' && void load());

  /** Replace a question after an action, or drop it when it moved to another list. */
  const settle = (q: InboxQuestion | null, id: string) => {
    setItems((cur) => (q && q.state === filter ? (cur?.map((x) => (x.id === id ? q : x)) ?? cur) : (cur?.filter((x) => x.id !== id) ?? cur)));
    if (!q || q.state !== filter) requestAnimationFrame(() => heading.current?.focus());
    void api.questions.inbox(filter).then(
      (r) => setCounts(r.counts),
      () => {},
    );
  };
  async function run(id: string, fn: () => Promise<InboxQuestion | null>, done?: string) {
    setBusy(id);
    try {
      settle(await fn(), id);
      if (done) toast(done);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function actions(q: InboxQuestion): MenuAction[] {
    const out: MenuAction[] = [];
    out.push({ label: t('ask.action.report'), icon: 'flag', onSelect: () => setReporting(q.id) });
    if (q.askedWithoutName ? !q.askerBlocked : true)
      out.push({
        label: t('ask.action.block'),
        icon: 'shield',
        danger: true,
        onSelect: () => {
          const ask = q.askedWithoutName ? t('ask.block.confirmHidden') : t('ask.block.confirmNamed', { name: q.asker?.username ?? '' });
          if (!confirm(ask)) return;
          void run(
            q.id,
            async () => (await api.questions.blockAsker(q.id)).question,
            q.askedWithoutName ? t('ask.block.doneHidden') : t('ask.block.doneNamed'),
          );
        },
      });
    if (q.askedWithoutName && q.askerBlocked)
      out.push({
        label: t('ask.action.unblock'),
        icon: 'shield',
        onSelect: () => void run(q.id, async () => (await api.questions.unblockAsker(q.id)).question, t('ask.unblock.done')),
      });
    out.push({
      label: t('ask.action.delete'),
      icon: 'trash',
      danger: true,
      onSelect: () => {
        if (!confirm(t('ask.delete.confirm'))) return;
        void run(
          q.id,
          async () => {
            await api.questions.remove(q.id);
            return null;
          },
          t('ask.deleted'),
        );
      },
    });
    return out;
  }

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1 ref={heading} tabIndex={-1}>
          {t('ask.title')}
        </h1>
        <Link href="/settings/account#ask" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('ask.box.title')}
        </Link>
      </div>
      {box && !box.enabled ? (
        <Alert tone="info">
          <span>{t('ask.box.off')}</span>{' '}
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              try {
                setBox((await api.questions.setBox({ enabled: true })).box);
                toast(t('ask.box.saved'));
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {t('ask.card.turnOn')}
          </Button>
        </Alert>
      ) : null}
      <Segments
        label={t('ask.inbox.filter')}
        value={filter}
        onChange={setFilter}
        options={ASK_FILTERS.map((id) => ({ id, label: counts?.[id] ? `${t(FILTER_LABEL[id])} (${counts[id]})` : t(FILTER_LABEL[id]) }))}
      />
      {items === null ? (
        <div className="stack" aria-busy>
          <Skeleton height={120} />
          <Skeleton height={120} />
        </div>
      ) : !items.length ? (
        <EmptyState title={t(EMPTY[filter])} />
      ) : (
        <ul className="stack ask-inbox" aria-label={t(FILTER_LABEL[filter])}>
          {items.map((q) => (
            <li key={q.id} className="yp-card ask-question">
              <QuestionQuote question={q} locale={locale} linkAs={NextLink}>
                {q.answer ? (
                  <p className="ask-answer__text">
                    <bdi>{q.answer}</bdi>
                  </p>
                ) : null}
              </QuestionQuote>
              <div className="ask-answer__foot">
                <time className="muted" dateTime={q.createdAt}>
                  {formatRelativeTime(q.createdAt, locale)}
                </time>
                {q.held ? <Badge tone="warning">{t('ask.answer.held')}</Badge> : null}
                {q.askerBlocked ? <Badge tone="neutral">{t('ask.blocked.note')}</Badge> : null}
                <span className="yp-spacer" />
                {q.state === 'new' && answering !== q.id ? (
                  <Button id={`answer-${q.id}`} size="sm" onClick={() => setAnswering(q.id)} disabled={busy === q.id}>
                    {t('ask.action.answer')}
                  </Button>
                ) : null}
                {q.state === 'hidden' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={busy === q.id}
                    onClick={() => void run(q.id, async () => (await api.questions.unhide(q.id)).question)}
                  >
                    {t('ask.action.unhide')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === q.id}
                    onClick={() => void run(q.id, async () => (await api.questions.hide(q.id)).question, t('ask.hidden.done'))}
                  >
                    {t('ask.action.hide')}
                  </Button>
                )}
                <Menu label={t('ask.action.more')} actions={actions(q)} />
              </div>
              {answering === q.id ? (
                <AnswerForm
                  onCancel={() => {
                    setAnswering(null);
                    // Back to the Answer button the form replaced.
                    requestAnimationFrame(() => document.getElementById(`answer-${q.id}`)?.focus());
                  }}
                  onSend={async (answer, share) => {
                    const r = await api.questions.answer(q.id, answer, share);
                    setAnswering(null);
                    settle(r.question, q.id);
                    toast(noticeText(r.moderation, t) ?? t('ask.answer.done'));
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {cursor ? (
        <Button variant="secondary" onClick={() => void load(cursor)}>
          {t('feed.loadMore')}
        </Button>
      ) : null}
      <ReportSheet target={reporting ? { type: 'question', id: reporting } : null} onClose={() => setReporting(null)} />
    </div>
  );
}

/** Write an answer; optionally share it as a post too, to the audience chosen. */
function AnswerForm({ onSend, onCancel }: { onSend: (answer: string, share?: { visibility: AskShareVisibility }) => Promise<void>; onCancel: () => void }) {
  const { t, toast } = useSession();
  const [answer, setAnswer] = useState('');
  const [share, setShare] = useState(false);
  const [visibility, setVisibility] = useState<AskShareVisibility>('public');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  return (
    <form
      className="stack-sm ask-answer-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!answer.trim()) return;
        setBusy(true);
        setError(undefined);
        try {
          await onSend(answer.trim(), share ? { visibility } : undefined);
        } catch (err) {
          setError(fieldErrors(err).answer ?? errorMessage(err));
          toast(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <TextField
        label={t('ask.answer.label')}
        multiline
        rows={3}
        autoFocus
        value={answer}
        maxLength={ASK_ANSWER_MAX}
        onChange={(e) => setAnswer(e.currentTarget.value)}
        error={error}
        hint={t('ask.card.count', { count: answer.length, max: ASK_ANSWER_MAX })}
      />
      <Checkbox label={t('ask.answer.share')} checked={share} onChange={(e) => setShare(e.currentTarget.checked)} />
      {share ? (
        <Select label={t('ask.answer.shareTo')} value={visibility} onChange={(e) => setVisibility(e.currentTarget.value as AskShareVisibility)}>
          {ASK_SHARE_VISIBILITIES.map((v) => (
            <option key={v} value={v}>
              {t(`visibility.${v}` as MessageKey)}
            </option>
          ))}
        </Select>
      ) : null}
      <div className="row">
        <Button type="submit" size="sm" loading={busy} disabled={!answer.trim()}>
          {t('ask.answer.send')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
