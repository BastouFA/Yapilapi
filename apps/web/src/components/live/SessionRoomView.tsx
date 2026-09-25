'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LIVE_REACTIONS } from '@yapilapi/api-client';
import type { LiveReactionKind, LiveSession } from '@yapilapi/api-client';
import {
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  MicIcon,
  Select,
  Switch,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner, ConfirmDialog } from '@/components/common';

type Tab = 'chat' | 'polls' | 'questions' | 'products' | 'team' | 'moderation' | 'settings';

const STATUS_KEYS = {
  live: 'live.status.live',
  scheduled: 'live.status.scheduled',
  ended: 'live.status.ended',
  cancelled: 'live.status.cancelled',
} as const;
const ROLE_KEYS = {
  host: 'live.role.host',
  cohost: 'live.role.cohost',
  moderator: 'live.role.moderator',
  audience: 'live.role.audience',
} as const;

/** Poll every few seconds while a tab is open, so the room feels live without a dedicated WebSocket client (documented gap). */
function usePoll(fn: () => void, ms: number, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ms]);
}

// ------------------------------------------------------------------ chat
function ChatPanel({ session }: { session: LiveSession }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.live.messages(session.id, { signal }), [api, session.id]);
  usePoll(state.reload, 4000, true);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError('');
    try {
      await api.live.postMessage(session.id, text.trim());
      setText('');
      state.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (mid: string) => {
    try {
      await api.live.hideMessage(session.id, mid);
      state.reload();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const react = async (kind: LiveReactionKind) => {
    try {
      await api.live.react(session.id, kind);
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  const team = session.viewerRole !== undefined && session.viewerRole !== 'audience';

  return (
    <div className="stack">
      <div className="button-row">
        {LIVE_REACTIONS.map((k) => (
          <Button key={k} size="sm" variant="ghost" onClick={() => void react(k)}>
            {k}
          </Button>
        ))}
      </div>

      {!session.chatEnabled && !team ? (
        <p className="muted">{t('live.chat.disabled')}</p>
      ) : (
        <div className="inline-form">
          <Input
            aria-label={t('live.chat.placeholder')}
            placeholder={t('live.chat.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button size="sm" loading={busy} onClick={() => void send()}>
            {t('live.chat.send')}
          </Button>
        </div>
      )}
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('live.chat.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((m) => (
            <li key={m.id} className="search-row">
              <span className="search-row__text">
                <span>{m.author?.displayName ?? '—'}</span>
                <span className="muted">{m.body}</span>
              </span>
              {team ? (
                <Button size="sm" variant="ghost" onClick={() => void remove(m.id)}>
                  {t('live.chat.remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ polls
function PollsPanel({ session }: { session: LiveSession }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.live.polls(session.id, { signal }), [api, session.id]);
  usePoll(state.reload, 4000, true);
  const team = session.viewerRole !== undefined && session.viewerRole !== 'audience';
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [multiple, setMultiple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api.live.createPoll(session.id, {
        question: question.trim(),
        options: options
          .split('\n')
          .map((o) => o.trim())
          .filter(Boolean),
        multiple,
      });
      toast.show({ tone: 'success', title: t('live.polls.created') });
      setQuestion('');
      setOptions('');
      state.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  const vote = async (pollId: string, optionId: string) => {
    try {
      await api.live.votePoll(session.id, pollId, [optionId]);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  const close = async (pollId: string) => {
    try {
      await api.live.closePoll(session.id, pollId);
      toast.show({ tone: 'success', title: t('live.polls.closed') });
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="stack">
      {team ? (
        <Card padding="md" className="stack-sm">
          <h4 className="section-title">{t('live.polls.new')}</h4>
          <FormField label={t('live.polls.question')}>
            <Input value={question} onChange={(e) => setQuestion(e.target.value)} />
          </FormField>
          <FormField label={t('live.polls.options')}>
            <Textarea value={options} onChange={(e) => setOptions(e.target.value)} rows={4} />
          </FormField>
          <Switch
            label={t('live.polls.multiple')}
            checked={multiple}
            onChange={(e) => setMultiple(e.target.checked)}
          />
          {error ? (
            <p className="yl-notice yl-notice--danger" role="alert">
              {error}
            </p>
          ) : null}
          <Button size="sm" loading={busy} onClick={() => void create()}>
            {t('live.polls.create')}
          </Button>
        </Card>
      ) : null}

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('live.polls.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).map((p) => (
        <Card key={p.id} padding="md" className="stack-sm">
          <p>
            <strong>{p.question}</strong>{' '}
            <span className="muted">
              {t(`live.polls.status.${p.status}`)} · {t('live.polls.voters', { count: p.voters })}
            </span>
          </p>
          <ul className="stack-sm">
            {p.options.map((o) => (
              <li key={o.id} className="search-row">
                <span className="search-row__text">
                  <span>{o.label}</span>
                  <span className="muted">{o.votes}</span>
                </span>
                {p.status === 'open' && !p.myVotes.includes(o.id) ? (
                  <Button size="sm" variant="ghost" onClick={() => void vote(p.id, o.id)}>
                    {t('live.polls.vote')}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          {team && p.status === 'open' ? (
            <Button size="sm" variant="ghost" onClick={() => void close(p.id)}>
              {t('live.polls.close')}
            </Button>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ questions
function QuestionsPanel({ session }: { session: LiveSession }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'answered'>('open');
  const state = useAsync(
    (signal) => api.live.questions(session.id, { status, signal }),
    [api, session.id, status],
  );
  usePoll(state.reload, 5000, true);
  const team = session.viewerRole !== undefined && session.viewerRole !== 'audience';
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [answering, setAnswering] = useState<string | null>(null);
  const [answerText, setAnswerText] = useState('');

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const ask = async () => {
    setBusy(true);
    setError('');
    try {
      await api.live.askQuestion(session.id, body.trim());
      toast.show({ tone: 'success', title: t('live.questions.asked') });
      setBody('');
      state.reload();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  const upvote = async (qid: string, on: boolean) => {
    try {
      await api.live.upvoteQuestion(session.id, qid, on);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  const answer = async (qid: string) => {
    setBusy(true);
    try {
      await api.live.answerQuestion(session.id, qid, answerText.trim());
      toast.show({ tone: 'success', title: t('live.questions.answered') });
      setAnswering(null);
      setAnswerText('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (qid: string) => {
    try {
      await api.live.dismissQuestion(session.id, qid);
      toast.show({ tone: 'success', title: t('live.questions.dismissed') });
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <FormField label={t('live.questions.ask')}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} />
        </FormField>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button size="sm" loading={busy} onClick={() => void ask()}>
          {t('live.questions.submit')}
        </Button>
      </Card>

      <FormField label={t('live.tab.questions')}>
        <Select value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'answered')}>
          <option value="open">{t('live.questions.filter.open')}</option>
          <option value="answered">{t('live.questions.filter.answered')}</option>
        </Select>
      </FormField>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('live.questions.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).map((q) => (
        <Card key={q.id} padding="md" className="stack-sm">
          <p>{q.body}</p>
          {q.answer ? <p className="muted">{q.answer}</p> : null}
          <div className="button-row">
            <Button size="sm" variant="ghost" onClick={() => void upvote(q.id, !q.viewerUpvoted)}>
              {q.viewerUpvoted ? t('live.questions.removeUpvote') : t('live.questions.upvote')} (
              {q.upvotes})
            </Button>
            {team && q.status === 'open' ? (
              <Button size="sm" variant="ghost" onClick={() => setAnswering(q.id)}>
                {t('live.questions.answer')}
              </Button>
            ) : null}
            {team ? (
              <Button size="sm" variant="ghost" onClick={() => void dismiss(q.id)}>
                {t('live.questions.dismiss')}
              </Button>
            ) : null}
          </div>
          {answering === q.id ? (
            <div className="inline-form">
              <Input
                aria-label={t('live.questions.answerPlaceholder')}
                placeholder={t('live.questions.answerPlaceholder')}
                value={answerText}
                onChange={(e) => setAnswerText(e.target.value)}
              />
              <Button size="sm" loading={busy} onClick={() => void answer(q.id)}>
                {t('live.questions.answerSubmit')}
              </Button>
            </div>
          ) : null}
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ products (shop)
function ProductsPanel({ session }: { session: LiveSession }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.live.products(session.id, { signal }), [api, session.id]);
  const team = session.viewerRole !== undefined && session.viewerRole !== 'audience';
  const [productId, setProductId] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const add = async () => {
    setBusy(true);
    try {
      await api.live.addProduct(session.id, productId.trim());
      toast.show({ tone: 'success', title: t('live.products.added') });
      setProductId('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.live.removeProduct(session.id, id);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  const togglePin = async (id: string, pinned: boolean) => {
    try {
      if (pinned) await api.live.unpinProduct(session.id, id);
      else await api.live.pinProduct(session.id, id);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="stack">
      {team ? (
        <Card padding="md" className="stack-sm">
          <FormField label={t('live.products.addId')}>
            <Input value={productId} onChange={(e) => setProductId(e.target.value)} />
          </FormField>
          <Button size="sm" loading={busy} onClick={() => void add()}>
            {t('live.products.add')}
          </Button>
        </Card>
      ) : null}

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('live.products.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).map((p) => (
        <li key={p.productId} className="search-row">
          <span className="search-row__text">
            <span>{p.title}</span>
            <span className="muted">
              {fmt.currency(p.priceCents / 100, p.currency)}
              {p.pinned ? ` · ${t('live.products.pinned')}` : ''}
            </span>
          </span>
          {team ? (
            <span className="button-row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void togglePin(p.productId, p.pinned)}
              >
                {p.pinned ? t('live.products.unpin') : t('live.products.pin')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void remove(p.productId)}>
                {t('live.products.remove')}
              </Button>
            </span>
          ) : null}
        </li>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ team
function TeamPanel({ session }: { session: LiveSession }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.live.team(session.id, { signal }), [api, session.id]);
  const isHost = session.viewerRole === 'host';
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'cohost' | 'moderator'>('cohost');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const add = async () => {
    setBusy(true);
    try {
      await api.live.setTeamMember(session.id, userId.trim(), role);
      toast.show({ tone: 'success', title: t('live.team.added') });
      setUserId('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (uid: string) => {
    try {
      await api.live.removeTeamMember(session.id, uid);
      toast.show({ tone: 'success', title: t('live.team.removed') });
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="stack">
      {isHost ? (
        <Card padding="md" className="stack-sm">
          <FormField label={t('live.team.addUserId')}>
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} />
          </FormField>
          <FormField label={t('live.team.addRole')}>
            <Select
              value={role}
              onChange={(e) => setRole(e.target.value as 'cohost' | 'moderator')}
            >
              <option value="cohost">{t('live.role.cohost')}</option>
              <option value="moderator">{t('live.role.moderator')}</option>
            </Select>
          </FormField>
          <Button size="sm" loading={busy} onClick={() => void add()}>
            {t('live.team.add')}
          </Button>
        </Card>
      ) : null}

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('live.team.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((m) => (
            <li key={m.userId} className="search-row">
              <span className="search-row__text">
                <span>{m.displayName}</span>
                <span className="muted">
                  {t(ROLE_KEYS[m.role as keyof typeof ROLE_KEYS] ?? 'live.role.audience')}
                </span>
              </span>
              {isHost && m.role !== 'host' ? (
                <Button size="sm" variant="ghost" onClick={() => void remove(m.userId)}>
                  {t('live.team.remove')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ moderation
function ModerationPanel({ session }: { session: LiveSession }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync(
    (signal) => api.live.moderation(session.id, { signal }),
    [api, session.id],
  );
  const [muteUserId, setMuteUserId] = useState('');
  const [muteMinutes, setMuteMinutes] = useState('10');
  const [banUserId, setBanUserId] = useState('');
  const [banReason, setBanReason] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const mute = async () => {
    setBusy(true);
    try {
      await api.live.mute(session.id, muteUserId.trim(), Math.round(Number(muteMinutes)) || 10);
      toast.show({ tone: 'success', title: t('live.moderation.muted') });
      setMuteUserId('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const unmute = async (uid: string) => {
    try {
      await api.live.unmute(session.id, uid);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };
  const ban = async () => {
    setBusy(true);
    try {
      await api.live.ban(session.id, banUserId.trim(), banReason.trim());
      toast.show({ tone: 'success', title: t('live.moderation.banned_toast') });
      setBanUserId('');
      setBanReason('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const unban = async (uid: string) => {
    try {
      await api.live.unban(session.id, uid);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <FormField label={t('live.moderation.muteUserId')}>
          <Input value={muteUserId} onChange={(e) => setMuteUserId(e.target.value)} />
        </FormField>
        <FormField label={t('live.moderation.muteMinutes')}>
          <Input
            type="number"
            min={1}
            max={1440}
            value={muteMinutes}
            onChange={(e) => setMuteMinutes(e.target.value)}
          />
        </FormField>
        <Button size="sm" loading={busy} onClick={() => void mute()}>
          {t('live.moderation.mute')}
        </Button>
      </Card>
      <Card padding="md" className="stack-sm">
        <FormField label={t('live.moderation.banUserId')}>
          <Input value={banUserId} onChange={(e) => setBanUserId(e.target.value)} />
        </FormField>
        <FormField label={t('live.moderation.banReason')}>
          <Input value={banReason} onChange={(e) => setBanReason(e.target.value)} />
        </FormField>
        <Button size="sm" loading={busy} onClick={() => void ban()}>
          {t('live.moderation.ban')}
        </Button>
      </Card>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('live.moderation.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).map((m) => (
        <li key={m.userId} className="search-row">
          <span className="search-row__text">
            <span>{m.username}</span>
            <span className="muted">
              {m.mutedUntil
                ? t('live.moderation.mutedUntil', { date: fmt.dateTime(m.mutedUntil) })
                : ''}
              {m.banned ? t('live.moderation.banned', { reason: m.banReason ?? '' }) : ''}
            </span>
          </span>
          <span className="button-row">
            {m.mutedUntil ? (
              <Button size="sm" variant="ghost" onClick={() => void unmute(m.userId)}>
                {t('live.moderation.unmute')}
              </Button>
            ) : null}
            {m.banned ? (
              <Button size="sm" variant="ghost" onClick={() => void unban(m.userId)}>
                {t('live.moderation.unban')}
              </Button>
            ) : null}
          </span>
        </li>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ settings (host/co-host)
function SettingsPanel({ session, onSaved }: { session: LiveSession; onSaved: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [chatEnabled, setChatEnabled] = useState(session.chatEnabled);
  const [slowModeSec, setSlowModeSec] = useState(String(session.slowModeSec));
  const [blockedTerms, setBlockedTerms] = useState((session.blockedTerms ?? []).join('\n'));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      await api.live.updateSettings(session.id, {
        chatEnabled,
        slowModeSec: Math.round(Number(slowModeSec)) || 0,
        blockedTerms: blockedTerms
          .split('\n')
          .map((t2) => t2.trim())
          .filter(Boolean),
      });
      toast.show({ tone: 'success', title: t('live.settings.saved') });
      onSaved();
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <Switch
        label={t('live.settings.chatEnabled')}
        checked={chatEnabled}
        onChange={(e) => setChatEnabled(e.target.checked)}
      />
      <FormField label={t('live.settings.slowModeSec')}>
        <Input
          type="number"
          min={0}
          max={300}
          value={slowModeSec}
          onChange={(e) => setSlowModeSec(e.target.value)}
        />
      </FormField>
      <FormField label={t('live.settings.blockedTerms')}>
        <Textarea value={blockedTerms} onChange={(e) => setBlockedTerms(e.target.value)} rows={4} />
      </FormField>
      <Button size="sm" loading={busy} onClick={() => void save()}>
        {t('live.settings.save')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ shell
export function SessionRoomView({ id }: { id: string }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const state = useAsync((signal) => api.live.get(id, { signal }), [api, id]);
  const [tab, setTab] = useState<Tab>('chat');
  const [endOpen, setEndOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  usePageTitle(state.data?.title, t('app.name'));

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const join = async () => {
    try {
      await api.live.join(id);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };
  const leave = async () => {
    try {
      await api.live.leave(id);
      state.reload();
    } catch (e) {
      fail(e);
    }
  };
  const start = async () => {
    setBusy(true);
    try {
      await api.live.start(id);
      toast.show({ tone: 'success', title: t('live.started') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  const end = async () => {
    setBusy(true);
    try {
      await api.live.end(id);
      toast.show({ tone: 'success', title: t('live.ended') });
      setEndOpen(false);
      state.reload();
    } catch (e) {
      fail(e);
      setEndOpen(false);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    setBusy(true);
    try {
      await api.live.cancel(id);
      toast.show({ tone: 'success', title: t('live.cancelled') });
      setCancelOpen(false);
      router.push('/live');
    } catch (e) {
      fail(e);
      setCancelOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const session = state.data;
  if (!session) return <EmptyState icon={<MicIcon size={28} />} title={t('live.notFound')} />;

  const team = session.viewerRole !== undefined && session.viewerRole !== 'audience';
  const isHost = session.viewerRole === 'host';

  return (
    <>
      <PageHeader
        title={session.title}
        lead={
          <>
            {t(STATUS_KEYS[session.status as keyof typeof STATUS_KEYS] ?? 'live.status.scheduled')}
            {session.status === 'live'
              ? ` · ${t('live.viewerCount', { count: session.viewerCount })}`
              : ''}
            {session.status === 'scheduled' && session.scheduledFor
              ? ` · ${t('live.scheduledFor', { date: fmt.dateTime(session.scheduledFor) })}`
              : ''}
          </>
        }
        actions={
          <span className="button-row">
            {isHost && session.status === 'scheduled' ? (
              <>
                <Button size="sm" loading={busy} onClick={() => void start()}>
                  {t('live.start')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
                  {t('live.cancel')}
                </Button>
              </>
            ) : null}
            {team && session.status === 'live' ? (
              <Button size="sm" variant="ghost" onClick={() => setEndOpen(true)}>
                {t('live.end')}
              </Button>
            ) : null}
            {!team && session.status === 'live' ? (
              <>
                <Button size="sm" onClick={() => void join()}>
                  {t('live.join')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void leave()}>
                  {t('live.leave')}
                </Button>
              </>
            ) : null}
          </span>
        }
      />
      {session.mediaMode === 'video' && session.status === 'scheduled' ? (
        <p className="yl-notice" role="status">
          {t('live.videoUnavailable')}
        </p>
      ) : null}

      <FeedTabs
        label={session.title}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'chat', label: t('live.tab.chat') },
          { id: 'polls', label: t('live.tab.polls') },
          { id: 'questions', label: t('live.tab.questions') },
          { id: 'products', label: t('live.tab.products') },
          ...(team
            ? [
                { id: 'team', label: t('live.tab.team') },
                { id: 'moderation', label: t('live.tab.moderation') },
                { id: 'settings', label: t('live.tab.settings') },
              ]
            : []),
        ]}
      >
        {tab === 'chat' ? <ChatPanel key="chat" session={session} /> : null}
        {tab === 'polls' ? <PollsPanel key="polls" session={session} /> : null}
        {tab === 'questions' ? <QuestionsPanel key="questions" session={session} /> : null}
        {tab === 'products' ? <ProductsPanel key="products" session={session} /> : null}
        {tab === 'team' && team ? <TeamPanel key="team" session={session} /> : null}
        {tab === 'moderation' && team ? (
          <ModerationPanel key="moderation" session={session} />
        ) : null}
        {tab === 'settings' && team ? (
          <SettingsPanel key="settings" session={session} onSaved={state.reload} />
        ) : null}
      </FeedTabs>

      <ConfirmDialog
        open={endOpen}
        title={t('live.endConfirm.title')}
        description={t('live.endConfirm.body')}
        confirmLabel={t('live.end')}
        danger
        busy={busy}
        onConfirm={() => void end()}
        onClose={() => setEndOpen(false)}
      />
      <ConfirmDialog
        open={cancelOpen}
        title={t('live.cancelConfirm.title')}
        description={t('live.cancelConfirm.body')}
        confirmLabel={t('live.cancel')}
        danger
        busy={busy}
        onConfirm={() => void cancel()}
        onClose={() => setCancelOpen(false)}
      />
    </>
  );
}
