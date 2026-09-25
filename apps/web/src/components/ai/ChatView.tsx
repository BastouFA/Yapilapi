'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AiAgent,
  AiAgentId,
  AiArtifact,
  AiChatResult,
  AiMessage,
  AiSafety,
  AiSourceRef,
} from '@yapilapi/api-client';
import {
  Button,
  Card,
  CheckIcon,
  EmptyState,
  FormField,
  Select,
  SparkIcon,
  Textarea,
  buttonClass,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';
import { ArtifactCard } from './ArtifactCard';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  notice?: string | null;
  sources?: AiSourceRef[];
  safety?: AiSafety;
  memorySuggestions?: string[];
  artifactIds?: string[];
}

function turnFromMessage(m: AiMessage): Turn {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    notice: m.notice,
    sources: (m.sources as AiSourceRef[] | null) ?? undefined,
    safety: m.safety as unknown as AiSafety,
    memorySuggestions: m.memorySuggestions,
    // A message's tool calls carry the id of any artifact (draft) they produced. Reading the id back
    // from here (rather than only from the just-sent chat response) is what makes a draft still show
    // inline after the client navigates from /ai to /ai/:conversationId, and on every later visit.
    artifactIds: (m.toolCalls ?? [])
      .map((c) => c.artifactId)
      .filter((id): id is string => Boolean(id)),
  };
}

function MemorySuggestionRow({ text }: { text: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.ai.createMemory({ content: text, source: 'user_approved_suggestion' });
      setSaved(true);
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
    <li className="inline-form">
      <span>{text}</span>
      {saved ? (
        <span className="muted">
          <CheckIcon size={14} /> {t('ai.memorySuggestionSaved')}
        </span>
      ) : (
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void save()}>
          {t('ai.memorySuggestionSave')}
        </Button>
      )}
    </li>
  );
}

function TurnView({
  turn,
  artifacts,
  onArtifactChanged,
  onArtifactRemoved,
}: {
  turn: Turn;
  artifacts: AiArtifact[];
  onArtifactChanged: (a: AiArtifact) => void;
  onArtifactRemoved: (id: string) => void;
}) {
  const { t, fmt } = useI18n();
  const isUser = turn.role === 'user';
  return (
    <li>
      <Card padding="md" className="stack-sm">
        <div className="entity-card__meta">
          <strong>{isUser ? t('ai.you') : t('ai.assistant')}</strong>
          <span className="muted">{fmt.relative(turn.createdAt)}</span>
        </div>
        <p style={{ whiteSpace: 'pre-wrap' }}>{turn.content}</p>
        {turn.notice ? <p className="yl-notice yl-notice--info">{turn.notice}</p> : null}
        {turn.safety?.refused ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {t('ai.safety.refused')}
          </p>
        ) : null}
        {turn.safety?.output === 'redacted' ? (
          <p className="yl-notice yl-notice--warning">{t('ai.safety.redacted')}</p>
        ) : null}
        {turn.safety?.injectionDetected ? (
          <p className="yl-notice yl-notice--warning">{t('ai.safety.injection')}</p>
        ) : null}
        {turn.sources && turn.sources.length > 0 ? (
          <div className="stack-sm">
            <span className="section-title">{t('ai.sourcesTitle')}</span>
            <ul className="stack-sm">
              {turn.sources.map((s, i) => (
                <li key={i} className="muted">
                  {s.type} · {s.id}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {turn.memorySuggestions && turn.memorySuggestions.length > 0 ? (
          <div className="stack-sm">
            <span className="section-title">{t('ai.memorySuggestionTitle')}</span>
            <ul className="stack-sm">
              {turn.memorySuggestions.map((s, i) => (
                <MemorySuggestionRow key={i} text={s} />
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
      {artifacts.length > 0 ? (
        <div className="stack-sm">
          {artifacts.map((a) => (
            <ArtifactCard
              key={a.id}
              artifact={a}
              onChanged={onArtifactChanged}
              onRemoved={onArtifactRemoved}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** The assistant chat. `conversationId` continues an existing chat; omit it to start a new one. */
export function ChatView({ conversationId }: { conversationId?: string }) {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  usePageTitle(t('ai.title'), t('app.name'));

  const agents = useAsync((signal) => api.ai.agents({ signal }), [api]);
  const history = useAsync(
    (signal) =>
      conversationId ? api.ai.messages(conversationId, { signal }) : Promise.resolve(null),
    [api, conversationId],
  );
  const recent = useAsync(
    (signal) =>
      conversationId ? Promise.resolve(null) : api.ai.conversations({ signal, limit: 10 }),
    [api, conversationId],
  );

  const [agent, setAgent] = useState<AiAgentId | ''>('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [artifactsById, setArtifactsById] = useState<Record<string, AiArtifact>>({});
  const [deleteOpen, setDeleteOpen] = useState(false);

  const loadedTurns = useMemo(
    () => (history.data ? history.data.items.map(turnFromMessage) : []),
    [history.data],
  );
  const allTurns = conversationId ? loadedTurns : turns;

  // History-loaded turns (a reopened conversation, or the redirect right after the first message)
  // carry artifact ids but not the artifacts themselves: fetch whichever of those ids isn't cached yet.
  useEffect(() => {
    const missing = new Set<string>();
    for (const turn of allTurns) for (const id of turn.artifactIds ?? []) missing.add(id);
    for (const id of Object.keys(artifactsById)) missing.delete(id);
    if (missing.size === 0) return;
    let cancelled = false;
    void Promise.all([...missing].map((id) => api.ai.artifact(id)))
      .then((loaded) => {
        if (cancelled) return;
        setArtifactsById((prev) => {
          const next = { ...prev };
          for (const a of loaded) next[a.id] = a;
          return next;
        });
      })
      .catch(() => {
        // Best-effort: a draft that fails to load here still shows under "Drafts" (AI drafts view).
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- artifactsById is read, not a dependency: including it would refetch on every load
  }, [allTurns, api]);

  const send = async () => {
    const text = message.trim();
    if (!text) return;
    setSending(true);
    const userTurn: Turn = {
      id: `local-${Date.now()}`,
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    };
    setTurns((prev) => [...prev, userTurn]);
    setMessage('');
    try {
      const r: AiChatResult = await api.ai.chat({
        message: text,
        conversationId,
        ...(!conversationId && agent ? { agent } : {}),
      });
      setTurns((prev) => [
        ...prev,
        {
          id: r.message.id,
          role: 'assistant',
          content: r.message.content,
          createdAt: r.message.createdAt,
          notice: r.notice,
          sources: r.sources,
          safety: r.safety,
          memorySuggestions: r.memorySuggestions,
          artifactIds: r.artifacts.map((a) => a.id),
        },
      ]);
      if (r.artifacts.length > 0) {
        const loaded = await Promise.all(r.artifacts.map((a) => api.ai.artifact(a.id)));
        setArtifactsById((prev) => {
          const next = { ...prev };
          for (const a of loaded) next[a.id] = a;
          return next;
        });
      }
      if (!conversationId) router.replace(`/ai/${r.conversationId}`);
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
      setTurns((prev) => prev.filter((tn) => tn.id !== userTurn.id));
      setMessage(text);
    } finally {
      setSending(false);
    }
  };

  const artifactsFor = (turn: Turn): AiArtifact[] =>
    (turn.artifactIds ?? [])
      .map((id) => artifactsById[id])
      .filter((a): a is AiArtifact => Boolean(a));

  const deleteConversation = async () => {
    if (!conversationId) return;
    try {
      await api.ai.deleteConversation(conversationId);
      router.push('/ai');
    } catch (e) {
      toast.show({
        tone: 'danger',
        title: t('error.actionFailed'),
        description: describeError(e, t).message,
      });
    }
  };

  return (
    <>
      <PageHeader
        title={t('ai.title')}
        lead={t('ai.lead')}
        actions={
          <div className="button-row">
            <Link href="/ai/drafts" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              {t('ai.drafts.title')}
            </Link>
            <Link href="/ai/memories" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              {t('nav.aiMemories')}
            </Link>
            <Link href="/ai/usage" className={buttonClass({ variant: 'secondary', size: 'sm' })}>
              {t('nav.aiUsage')}
            </Link>
            {conversationId ? (
              <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
                {t('ai.deleteConversation')}
              </Button>
            ) : (
              <Link href="/ai" className={buttonClass({ variant: 'ghost', size: 'sm' })}>
                {t('ai.newChat')}
              </Link>
            )}
          </div>
        }
      />

      {!conversationId && !agent && turns.length === 0 && agents.data ? (
        <Card padding="md" className="stack-sm">
          <FormField label={t('ai.agentLabel')}>
            <Select value={agent} onChange={(e) => setAgent(e.target.value as AiAgentId)}>
              <option value="">{t('ai.agent.social')}</option>
              {agents.data.items.map((a: AiAgent) => (
                <option key={a.id} value={a.id} disabled={!a.availableToYou}>
                  {t(`ai.agent.${a.id}`)}
                  {!a.availableToYou ? ` — ${t('ai.agentNotAvailable')}` : ''}
                </option>
              ))}
            </Select>
          </FormField>
        </Card>
      ) : null}

      {conversationId && history.loading ? <PageSpinner /> : null}
      {conversationId && history.error ? (
        <ErrorView error={history.error} onRetry={history.reload} />
      ) : null}

      {!conversationId && recent.data && recent.data.items.length > 0 && turns.length === 0 ? (
        <div className="stack-sm">
          <span className="section-title">{t('ai.conversationsTitle')}</span>
          <ul className="stack-sm">
            {recent.data.items.map((c) => (
              <li key={c.id}>
                <Link href={`/ai/${c.id}`} className="link-btn">
                  {c.title || t('ai.untitledChat')}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {allTurns.length === 0 && !(conversationId && history.loading) ? (
        <EmptyState
          icon={<SparkIcon size={28} />}
          title={t('ai.emptyTitle')}
          description={t('ai.emptyBody')}
        />
      ) : (
        <ul className="stack">
          {allTurns.map((turn) => (
            <TurnView
              key={turn.id}
              turn={turn}
              artifacts={artifactsFor(turn)}
              onArtifactChanged={(a) => setArtifactsById((prev) => ({ ...prev, [a.id]: a }))}
              onArtifactRemoved={(id) =>
                setArtifactsById((prev) => {
                  const next = { ...prev };
                  delete next[id];
                  return next;
                })
              }
            />
          ))}
        </ul>
      )}

      <Card padding="md" className="stack-sm">
        <Textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t('ai.composerPlaceholder')}
          rows={3}
          disabled={sending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          data-testid="ai-composer"
        />
        <div className="button-row">
          <Button
            onClick={() => void send()}
            loading={sending}
            loadingLabel={t('ai.sending')}
            disabled={!message.trim()}
          >
            {t('ai.send')}
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={deleteOpen}
        title={t('ai.deleteConversationDialogTitle')}
        description={t('ai.deleteConversationDialogBody')}
        confirmLabel={t('ai.deleteConversation')}
        danger
        onConfirm={() => void deleteConversation()}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}
