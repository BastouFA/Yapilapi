'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, Checkbox, EmptyState, QuestionQuote, Skeleton, Switch, TextField } from '@yapilapi/design-system';
import {
  ASK_PROMPT_MAX,
  ASK_QUESTION_MAX,
  formatRelativeTime,
  type AnswerCard,
  type AskAudience,
  type AskBoxSettings,
  type AskRefusal,
  type MessageKey,
  type Profile,
} from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { NextLink } from '@/lib/link';
import { useSession } from '@/app/providers';
import { ReportSheet } from '@/components/PostList';
import { useSignIn } from '@/components/SignedOut';
import { Anchor, ChoiceGroup } from '@/components/settings/Shell';

const REFUSAL: Partial<Record<AskRefusal, MessageKey>> = {
  audience: 'ask.refusal.audience',
  private: 'ask.refusal.private',
  minor: 'ask.refusal.minor',
  blocked: 'ask.refusal.blocked',
};

/**
 * The question box on a profile. Visitors see the prompt and ask (with "Ask without your name
 * shown" when the owner allows it); signed out, it leads to sign in; when they can't ask, it
 * says why. On your own profile: your box's prompt and the way to your questions, or a way to
 * turn it on.
 */
export function AskCard({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const { me, t, toast } = useSession();
  const signIn = useSignIn();
  const [body, setBody] = useState('');
  const [hideName, setHideName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const box = profile.ask;
  const isSelf = profile.relationship.isSelf;
  // Turning the box on swaps the card: focus moves from the button that went to the link that came.
  const openLink = useRef<HTMLAnchorElement>(null);
  const [turnedOn, setTurnedOn] = useState(false);
  useEffect(() => {
    if (!turnedOn || !box?.enabled) return;
    openLink.current?.focus();
    setTurnedOn(false);
  }, [turnedOn, box?.enabled]);

  if (isSelf) {
    if (!box?.enabled)
      return (
        <Card level={2} className="ask-card ask-card--self">
          <div className="ask-card__row">
            <p className="muted" style={{ margin: 0 }}>
              {t('ask.card.self')}
            </p>
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.questions.setBox({ enabled: true });
                  toast(t('ask.box.saved'));
                  setTurnedOn(true);
                  onChanged();
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('ask.card.turnOn')}
            </Button>
          </div>
        </Card>
      );
    return (
      <Card level={2} className="ask-card ask-card--self" title={t('ask.box.title')} subtitle={box.prompt ?? undefined}>
        <div className="row">
          <Link ref={openLink} href="/questions" className="yp-btn yp-btn--secondary yp-btn--sm">
            {t('ask.box.open')}
          </Link>
          <Link href="/settings/account#ask" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('ask.box.title')}
          </Link>
        </div>
      </Card>
    );
  }

  if (!box?.enabled) return null;
  const title = t('ask.card.title', { name: profile.displayName });

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return setError(t('ask.card.placeholder'));
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.questions.ask(profile.id, body.trim(), hideName && !!box?.hiddenNamesAllowed);
      toast(r.notice ?? t('ask.card.sent'));
      setBody('');
      setHideName(false);
    } catch (err) {
      setError(fieldErrors(err).body ?? errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card level={2} className="ask-card" title={title} subtitle={box.prompt ?? undefined}>
      {!me ? (
        <Button size="sm" onClick={signIn}>
          {t('ask.card.signIn')}
        </Button>
      ) : !box.canAsk ? (
        <p className="muted" style={{ margin: 0 }}>
          {t(REFUSAL[box.refusal ?? 'blocked'] ?? 'ask.refusal.blocked', { name: profile.displayName })}
        </p>
      ) : (
        <form className="stack-sm" onSubmit={send}>
          <TextField
            label={t('ask.card.placeholder')}
            multiline
            rows={3}
            value={body}
            maxLength={ASK_QUESTION_MAX}
            onChange={(e) => setBody(e.currentTarget.value)}
            error={error}
            hint={t('ask.card.count', { count: body.length, max: ASK_QUESTION_MAX })}
          />
          {box.hiddenNamesAllowed ? (
            <Checkbox
              label={t('ask.card.hideName')}
              description={t('ask.card.hideNameHint', { name: profile.displayName })}
              checked={hideName}
              onChange={(e) => setHideName(e.currentTarget.checked)}
            />
          ) : null}
          <div className="row">
            <Button type="submit" size="sm" loading={busy} disabled={!body.trim()}>
              {t('ask.card.send')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** One answered question: the question, who asked it (or that it was asked without a name) and the answer. */
export function AnswerView({ card, onReport }: { card: AnswerCard; onReport?: (card: AnswerCard) => void }) {
  const { t, locale } = useSession();
  return (
    <article className="yp-card ask-answer" aria-label={t('ask.card.answer')}>
      <QuestionQuote question={card} locale={locale} linkAs={NextLink}>
        <p className="ask-answer__text">
          <bdi>{card.answer}</bdi>
        </p>
      </QuestionQuote>
      <div className="ask-answer__foot">
        <time className="muted" dateTime={card.answeredAt}>
          {formatRelativeTime(card.answeredAt, locale)}
        </time>
        {card.held ? <Badge tone="warning">{t('ask.answer.held')}</Badge> : null}
        <span className="yp-spacer" />
        {onReport ? (
          <Button size="sm" variant="ghost" icon="flag" onClick={() => onReport(card)}>
            {t('ask.action.report')}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

/** The Answers tab of a profile, newest first. */
export function AnswersTab({ profile }: { profile: Profile }) {
  const { me, t, toast } = useSession();
  const [items, setItems] = useState<AnswerCard[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [reporting, setReporting] = useState<string | null>(null);
  const load = useCallback(
    async (next?: string) => {
      try {
        const page = await api.questions.answers(profile.id, next);
        setItems((cur) => (next && cur ? [...cur, ...page.items.filter((x) => !cur.some((y) => y.id === x.id))] : page.items));
        setCursor(page.nextCursor);
      } catch (e) {
        setItems((cur) => cur ?? []);
        toast(errorMessage(e));
      }
    },
    [profile.id, toast],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (!items)
    return (
      <div className="stack" aria-busy>
        <Skeleton height={120} />
        <Skeleton height={120} />
      </div>
    );
  if (!items.length) return <EmptyState title={t('ask.answers.empty')} body={profile.relationship.isSelf ? t('ask.answers.emptySelf') : undefined} />;
  const canReport = !!me && !profile.relationship.isSelf;
  return (
    <div className="stack">
      {items.map((card) => (
        <AnswerView key={card.id} card={card} onReport={canReport ? (c) => setReporting(c.id) : undefined} />
      ))}
      {cursor ? (
        <Button
          variant="secondary"
          loading={more}
          onClick={async () => {
            setMore(true);
            await load(cursor);
            setMore(false);
          }}
        >
          {t('feed.loadMore')}
        </Button>
      ) : null}
      <ReportSheet target={reporting ? { type: 'answer', id: reporting } : null} onClose={() => setReporting(null)} />
    </div>
  );
}

/**
 * Settings: your question box. On or off, the prompt shown above it, who can ask, and whether
 * people may ask without their name shown (never for accounts of people under 18).
 */
export function AskBoxCard() {
  const { t, toast } = useSession();
  const [box, setBox] = useState<AskBoxSettings | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  useEffect(() => {
    api.questions.box().then(
      (r) => {
        setBox(r.box);
        setPrompt(r.box.prompt ?? '');
      },
      (e) => toast(errorMessage(e)),
    );
  }, [toast]);
  if (!box) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!box) return;
    setBusy(true);
    setFields({});
    try {
      const r = await api.questions.setBox({
        enabled: box.enabled,
        prompt: prompt.trim() || null,
        audience: box.audience,
        allowHiddenNames: box.allowHiddenNames,
      });
      setBox(r.box);
      setPrompt(r.box.prompt ?? '');
      toast(t('ask.box.saved'));
    } catch (err) {
      setFields(fieldErrors(err));
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Anchor id="ask">
      <Card title={t('ask.box.title')} subtitle={t('ask.box.desc')}>
        <form className="stack" onSubmit={save}>
          <Switch label={t('ask.box.enable')} checked={box.enabled} onChange={(v) => setBox({ ...box, enabled: v })} />
          <TextField
            label={t('ask.box.prompt')}
            value={prompt}
            maxLength={ASK_PROMPT_MAX}
            onChange={(e) => setPrompt(e.currentTarget.value)}
            hint={t('ask.box.promptHint')}
            error={fields.prompt}
          />
          <ChoiceGroup<AskAudience>
            legend={t('ask.box.audience')}
            value={box.audience}
            onChange={(v) => setBox({ ...box, audience: v })}
            options={[
              { id: 'everyone', label: t('ask.audience.everyone') },
              { id: 'following', label: t('ask.audience.following') },
              { id: 'friends', label: t('ask.audience.friends') },
            ]}
          />
          <Checkbox
            label={t('ask.box.hiddenNames')}
            description={box.hiddenNamesAvailable ? t('ask.box.hiddenNamesHint') : t('ask.box.hiddenNamesMinor')}
            checked={box.allowHiddenNames}
            disabled={!box.hiddenNamesAvailable}
            onChange={(e) => setBox({ ...box, allowHiddenNames: e.currentTarget.checked })}
          />
          <div className="row">
            <Button type="submit" loading={busy}>
              {t('common.save')}
            </Button>
            <Link href="/questions" className="yp-btn yp-btn--ghost">
              {t('ask.box.open')}
            </Link>
          </div>
        </form>
      </Card>
    </Anchor>
  );
}
