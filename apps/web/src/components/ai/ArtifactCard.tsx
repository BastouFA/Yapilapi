'use client';

import { useState } from 'react';
import type { AiArtifact, AiConfirmInput } from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  CheckIcon,
  EditIcon,
  FormField,
  Input,
  Radio,
  RadioGroup,
  ShareIcon,
  Textarea,
  TrashIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { describeError } from '@/lib/errors';
import { ConfirmDialog } from '@/components/common';

type Payload = Record<string, unknown>;
type Kind =
  | 'post_draft'
  | 'reply_draft'
  | 'caption'
  | 'plan'
  | 'event_draft'
  | 'translation'
  | 'titles'
  | 'description'
  | 'thumbnail_concepts'
  | 'other';
const OTHER_TYPES = new Set(['titles', 'description', 'thumbnail_concepts']);
const KIND_LABEL_KEYS = {
  post_draft: 'ai.drafts.kind.post_draft',
  reply_draft: 'ai.drafts.kind.reply_draft',
  caption: 'ai.drafts.kind.caption',
  plan: 'ai.drafts.kind.plan',
  event_draft: 'ai.drafts.kind.event_draft',
  translation: 'ai.drafts.kind.translation',
  titles: 'ai.drafts.kind.titles',
  description: 'ai.drafts.kind.description',
  thumbnail_concepts: 'ai.drafts.kind.thumbnail_concepts',
  other: 'ai.drafts.kind.other',
} as const satisfies Record<Kind, string>;

/** `other`-kind artifacts (titles / description / thumbnail concepts) are told apart by `payload.type`. */
function effectiveKind(a: AiArtifact): Kind {
  if (a.kind !== 'other') return a.kind;
  const kt = (a.payload as Payload).type;
  return typeof kt === 'string' && OTHER_TYPES.has(kt) ? (kt as Kind) : 'other';
}

/** One AI draft. Editing and picking an option only change the draft; only Confirm performs the real action. */
export function ArtifactCard({
  artifact,
  onChanged,
  onRemoved,
}: {
  artifact: AiArtifact;
  onChanged: (a: AiArtifact) => void;
  onRemoved: (id: string) => void;
}) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const kind = effectiveKind(artifact);
  const payload = artifact.payload as Payload;

  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [selected, setSelected] = useState<number>(
    typeof payload.selected === 'number' ? payload.selected : 0,
  );
  const [bodyDraft, setBodyDraft] = useState(
    typeof payload.body === 'string'
      ? payload.body
      : typeof payload.text === 'string'
        ? payload.text
        : '',
  );
  const [conversationId, setConversationId] = useState(
    typeof (payload as { conversationId?: unknown }).conversationId === 'string'
      ? String((payload as { conversationId?: unknown }).conversationId)
      : '',
  );

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const saveEdit = async () => {
    setBusy(true);
    try {
      const patch: Record<string, unknown> =
        kind === 'caption'
          ? { selected }
          : kind === 'description' || kind === 'translation'
            ? { text: bodyDraft }
            : { body: bodyDraft };
      const a = await api.ai.editArtifact(artifact.id, patch);
      onChanged(a);
      setEditing(false);
      toast.show({ tone: 'success', title: t('common.saved') });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doConfirm = async () => {
    setBusy(true);
    try {
      const input: AiConfirmInput = {};
      if (kind === 'caption' || kind === 'titles') input.selected = selected;
      if (kind === 'reply_draft' && conversationId) input.conversationId = conversationId;
      if (kind === 'plan' && conversationId) input.conversationId = conversationId;
      const r = await api.ai.confirmArtifact(artifact.id, input);
      onChanged(r.artifact);
      setConfirmOpen(false);
      toast.show({
        tone: 'success',
        title: t(`ai.drafts.action.${r.action}`),
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const doDiscard = async () => {
    setBusy(true);
    try {
      await api.ai.discardArtifact(artifact.id);
      onRemoved(artifact.id);
      setDiscardOpen(false);
    } catch (e) {
      fail(e);
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.show({ tone: 'success', title: t('post.linkCopied') });
    } catch {
      // clipboard can be unavailable (permissions, insecure context); nothing to recover here
    }
  };

  const done = artifact.status !== 'draft';
  const kindLabelKey = KIND_LABEL_KEYS[kind];

  return (
    <Card padding="md" className="stack-sm" data-testid="ai-artifact" data-kind={kind}>
      <div className="inline-form" style={{ justifyContent: 'space-between' }}>
        <Badge>{t(kindLabelKey)}</Badge>
        {artifact.edited ? <Badge tone="neutral">{t('ai.drafts.edited')}</Badge> : null}
        {done ? (
          <Badge tone={artifact.status === 'confirmed' ? 'success' : 'neutral'}>
            {t(`ai.drafts.tab.${artifact.status}`)}
          </Badge>
        ) : null}
      </div>

      {/* -------------------------------------------------- body */}
      {kind === 'post_draft' || kind === 'reply_draft' ? (
        editing ? (
          <Textarea
            value={bodyDraft}
            onChange={(e) => setBodyDraft(e.target.value)}
            rows={4}
            disabled={busy}
          />
        ) : (
          <p>{String(payload.body ?? '')}</p>
        )
      ) : null}

      {kind === 'description' || kind === 'translation' ? (
        editing && kind === 'description' ? (
          <Textarea
            value={bodyDraft}
            onChange={(e) => setBodyDraft(e.target.value)}
            rows={4}
            disabled={busy}
          />
        ) : (
          <p>{String(payload.text ?? '')}</p>
        )
      ) : null}

      {kind === 'caption' || kind === 'titles' ? (
        <RadioGroup
          legend={t('ai.drafts.selectOption')}
          value={String(selected)}
          onValueChange={(v) => setSelected(Number(v))}
        >
          {(kind === 'caption'
            ? ((payload.options as string[] | undefined) ?? [])
            : ((payload.titles as string[] | undefined) ?? [])
          ).map((opt, i) => (
            <Radio key={i} value={String(i)} label={opt} card />
          ))}
        </RadioGroup>
      ) : null}

      {kind === 'thumbnail_concepts' ? (
        <ul className="stack-sm">
          {((payload.concepts as Array<{ prompt: string; style?: string }> | undefined) ?? []).map(
            (c, i) => (
              <li key={i} className="search-row">
                <span className="search-row__text">
                  <span>{c.prompt}</span>
                  {c.style ? <span className="muted">{c.style}</span> : null}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  leadingIcon={<ShareIcon size={14} />}
                  onClick={() => void copy(c.prompt)}
                >
                  {t('common.copy')}
                </Button>
              </li>
            ),
          )}
        </ul>
      ) : null}

      {kind === 'event_draft' ? (
        <div className="stack-sm">
          <p>
            <strong>{String(payload.title ?? '')}</strong>
          </p>
          {payload.description ? <p>{String(payload.description)}</p> : null}
          {payload.startsAt ? <p>{fmt.dateTime(String(payload.startsAt))}</p> : null}
          {payload.locationText ? <p>{String(payload.locationText)}</p> : null}
        </div>
      ) : null}

      {kind === 'plan'
        ? (() => {
            const plan = (payload.plan as Record<string, unknown> | undefined) ?? {};
            return (
              <div className="stack-sm">
                <p>
                  <strong>{String(plan.title ?? '')}</strong>
                </p>
                {plan.destination ? <p>{String(plan.destination)}</p> : null}
                {plan.startsOn || plan.endsOn ? (
                  <p>
                    {String(plan.startsOn ?? '?')} – {String(plan.endsOn ?? '?')}
                  </p>
                ) : null}
                {Array.isArray(plan.activities) && plan.activities.length > 0 ? (
                  <p>{(plan.activities as string[]).join(', ')}</p>
                ) : null}
                {Array.isArray(plan.missing) && plan.missing.length > 0 ? (
                  <p className="muted">{(plan.missing as string[]).join(', ')}</p>
                ) : null}
              </div>
            );
          })()
        : null}

      {(kind === 'reply_draft' || kind === 'plan') && !conversationId ? (
        <FormField label={t('ai.drafts.conversationIdLabel')}>
          <Input
            value={conversationId}
            onChange={(e) => setConversationId(e.target.value)}
            placeholder={t('ai.drafts.conversationIdPlaceholder')}
          />
        </FormField>
      ) : null}

      {!done ? (
        <div className="button-row">
          {['post_draft', 'reply_draft', 'description', 'translation'].includes(kind) ? (
            editing ? (
              <>
                <Button size="sm" loading={busy} onClick={() => void saveEdit()}>
                  {t('ai.drafts.editSave')}
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                  {t('ai.drafts.editCancel')}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                leadingIcon={<EditIcon size={14} />}
                onClick={() => setEditing(true)}
              >
                {t('ai.drafts.edit')}
              </Button>
            )
          ) : null}
          <Button
            size="sm"
            leadingIcon={<CheckIcon size={14} />}
            onClick={() => setConfirmOpen(true)}
          >
            {t('ai.drafts.confirm')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<TrashIcon size={14} />}
            onClick={() => setDiscardOpen(true)}
          >
            {t('ai.drafts.discard')}
          </Button>
        </div>
      ) : artifact.result != null ? (
        <p className="muted">{JSON.stringify(artifact.result)}</p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t('ai.drafts.confirmDialogTitle')}
        description={t('ai.drafts.confirmDialogBody', { kind: t(kindLabelKey) })}
        confirmLabel={t('ai.drafts.confirm')}
        busy={busy}
        onConfirm={() => void doConfirm()}
        onClose={() => setConfirmOpen(false)}
      />
      <ConfirmDialog
        open={discardOpen}
        title={t('ai.drafts.discardDialogTitle')}
        description={t('ai.drafts.discardDialogBody')}
        confirmLabel={t('ai.drafts.discard')}
        danger
        busy={busy}
        onConfirm={() => void doDiscard()}
        onClose={() => setDiscardOpen(false)}
      />
    </Card>
  );
}
