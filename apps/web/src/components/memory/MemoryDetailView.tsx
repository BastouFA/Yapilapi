'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  MemoryAiDraft,
  MemoryAiDraftKind,
  MemoryItemType,
  MemoryLinkType,
  MemoryPrivacy,
  MemoryView,
} from '@yapilapi/api-client';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  ImageIcon,
  Input,
  Select,
  Textarea,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';
import { ITEM_TYPE_KEYS, ITEM_TYPES, KIND_KEYS } from './MemoriesListView';

type Tab = 'edit' | 'items' | 'links' | 'recap' | 'aiDrafts' | 'export';

const LINK_TYPE_KEYS = {
  person: 'memory.links.type.person',
  place: 'memory.links.type.place',
  event: 'memory.links.type.event',
  trip: 'memory.links.type.trip',
  community: 'memory.links.type.community',
  experience: 'memory.links.type.experience',
} as const satisfies Record<MemoryLinkType, string>;
const LINK_TYPES: MemoryLinkType[] = [
  'person',
  'place',
  'event',
  'trip',
  'community',
  'experience',
];

const AI_DRAFT_KIND_KEYS = {
  title: 'memory.aiDrafts.kind.title',
  summary: 'memory.aiDrafts.kind.summary',
  highlights: 'memory.aiDrafts.kind.highlights',
} as const satisfies Record<MemoryAiDraftKind, string>;

function fail(toast: ReturnType<typeof useToast>, t: ReturnType<typeof useI18n>['t'], e: unknown) {
  toast.show({
    tone: 'danger',
    title: t('error.actionFailed'),
    description: describeError(e, t).message,
  });
}

// ------------------------------------------------------------------ edit
function EditPanel({ memory, onSaved }: { memory: MemoryView; onSaved: (m: MemoryView) => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [title, setTitle] = useState(memory.title);
  const [summary, setSummary] = useState(memory.summary);
  const [privacy, setPrivacy] = useState<MemoryPrivacy>(memory.privacy);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const m = await api.memory.update(memory.id, {
        title: title.trim(),
        summary: summary.trim(),
        privacy,
      });
      toast.show({ tone: 'success', title: t('memory.edit.saved') });
      onSaved(m);
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <FormField label={t('memory.form.title')} required>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </FormField>
      <FormField label={t('memory.form.summary')}>
        <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} />
      </FormField>
      <FormField label={t('memory.form.privacy')}>
        <Select value={privacy} onChange={(e) => setPrivacy(e.target.value as MemoryPrivacy)}>
          <option value="private">{t('memory.form.privacy.private')}</option>
          <option value="friends">{t('memory.form.privacy.friends')}</option>
          <option value="public">{t('memory.form.privacy.public')}</option>
        </Select>
      </FormField>
      <Button loading={busy} disabled={!title.trim()} onClick={() => void save()}>
        {t('memory.edit.save')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ items
function ItemsPanel({ memory, onChanged }: { memory: MemoryView; onChanged: () => void }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const [type, setType] = useState<MemoryItemType>('post');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api.memory.addItems(memory.id, [{ type, id: id.trim() }]);
      toast.show({ tone: 'success', title: t('memory.items.added') });
      setId('');
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (it: MemoryItemType, itemId: string) => {
    try {
      await api.memory.removeItem(memory.id, it, itemId);
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <FormField label={t('memory.items.addType')}>
          <Select value={type} onChange={(e) => setType(e.target.value as MemoryItemType)}>
            {ITEM_TYPES.map((it) => (
              <option key={it} value={it}>
                {t(ITEM_TYPE_KEYS[it])}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('memory.items.addId')}>
          <Input value={id} onChange={(e) => setId(e.target.value)} />
        </FormField>
        <Button size="sm" loading={busy} disabled={!id.trim()} onClick={() => void add()}>
          {t('memory.items.add')}
        </Button>
      </Card>

      {memory.items.length === 0 ? <p className="muted">{t('memory.items.empty')}</p> : null}
      {memory.items.length > 0 ? (
        <ul className="stack-sm">
          {memory.items.map((i) => (
            <li key={`${i.type}:${i.id}`} className="search-row">
              <span className="search-row__text">
                <span>{i.text || t(ITEM_TYPE_KEYS[i.type])}</span>
                <span className="muted">
                  {t(ITEM_TYPE_KEYS[i.type])}
                  {i.at ? ` · ${fmt.dateTime(i.at)}` : ''}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void remove(i.type, i.id)}>
                {t('memory.items.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {memory.unavailableItemCount ? (
        <p className="muted">
          {t('memory.items.unavailable', { count: memory.unavailableItemCount })}
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ links
function LinksPanel({ memory, onChanged }: { memory: MemoryView; onChanged: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [type, setType] = useState<MemoryLinkType>('person');
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api.memory.addLinks(memory.id, [{ type, id: id.trim() }]);
      toast.show({ tone: 'success', title: t('memory.links.added') });
      setId('');
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (lt: MemoryLinkType, entityId: string) => {
    try {
      await api.memory.removeLink(memory.id, lt, entityId);
      onChanged();
    } catch (e) {
      fail(toast, t, e);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <FormField label={t('memory.links.addType')}>
          <Select value={type} onChange={(e) => setType(e.target.value as MemoryLinkType)}>
            {LINK_TYPES.map((lt) => (
              <option key={lt} value={lt}>
                {t(LINK_TYPE_KEYS[lt])}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={t('memory.links.addId')}>
          <Input value={id} onChange={(e) => setId(e.target.value)} />
        </FormField>
        <Button size="sm" loading={busy} disabled={!id.trim()} onClick={() => void add()}>
          {t('memory.links.add')}
        </Button>
      </Card>

      {memory.links.length === 0 ? <p className="muted">{t('memory.links.empty')}</p> : null}
      {memory.links.length > 0 ? (
        <ul className="stack-sm">
          {memory.links.map((l) => (
            <li key={`${l.type}:${l.id}`} className="search-row">
              <span className="search-row__text">
                <span>{l.label}</span>
                <span className="muted">{t(LINK_TYPE_KEYS[l.type])}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void remove(l.type, l.id)}>
                {t('memory.links.remove')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ recap
function RecapPanel({ memory, onApplied }: { memory: MemoryView; onApplied: () => void }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.memory.recap(memory.id, { signal }), [api, memory.id]);
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    try {
      await api.memory.applyRecap(memory.id);
      toast.show({ tone: 'success', title: t('memory.recap.applied') });
      onApplied();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const recap = state.data?.recap;
  if (!recap) return null;

  return (
    <Card padding="md" className="stack-sm">
      <p className="muted">{t('memory.recap.lead')}</p>
      <p>{state.data?.text}</p>
      <ul className="stack-sm">
        <li>{t('memory.recap.total', { count: recap.total })}</li>
        {recap.dateStart && recap.dateEnd ? (
          <li>
            {t('memory.recap.span', {
              days: recap.spanDays,
              start: fmt.dateTime(recap.dateStart),
              end: fmt.dateTime(recap.dateEnd),
            })}
          </li>
        ) : null}
        <li>{t('memory.recap.places', { count: recap.places })}</li>
        <li>{t('memory.recap.people', { count: recap.people })}</li>
      </ul>
      <Button size="sm" loading={busy} onClick={() => void apply()}>
        {t('memory.recap.apply')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ AI drafts (explicit confirm, never auto-applied)
function AiDraftRow({
  d,
  memoryId,
  onResolved,
}: {
  d: MemoryAiDraft;
  memoryId: string;
  onResolved: (m: MemoryView | null) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(typeof d.payload.text === 'string' ? d.payload.text : '');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const canEditText = d.kind === 'title' || d.kind === 'summary';
  const done = d.status !== 'pending';

  const confirm = async () => {
    setBusy(true);
    try {
      const m = await api.memory.confirmAiDraft(
        memoryId,
        d.id,
        canEditText && editing ? text.trim() : undefined,
      );
      toast.show({ tone: 'success', title: t('memory.aiDrafts.confirmed') });
      setConfirmOpen(false);
      onResolved(m);
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setBusy(false);
    }
  };
  const discard = async () => {
    setBusy(true);
    try {
      await api.memory.discardAiDraft(memoryId, d.id);
      setDiscardOpen(false);
      onResolved(null);
    } catch (e) {
      fail(toast, t, e);
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm" data-testid="memory-ai-draft">
      <div className="inline-form" style={{ justifyContent: 'space-between' }}>
        <Badge>{t(AI_DRAFT_KIND_KEYS[d.kind])}</Badge>
        {done ? <Badge tone="neutral">{t(`memory.aiDrafts.status.${d.status}`)}</Badge> : null}
      </div>
      {d.kind === 'highlights' ? (
        <p className="muted">
          {Array.isArray(d.payload.items) ? (d.payload.items as unknown[]).length : 0} items picked
        </p>
      ) : editing ? (
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} disabled={busy} />
      ) : (
        <p>{typeof d.payload.text === 'string' ? d.payload.text : ''}</p>
      )}
      {!done ? (
        <div className="button-row">
          {canEditText ? (
            <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
              {t('memory.aiDrafts.edit')}
            </Button>
          ) : null}
          <Button size="sm" onClick={() => setConfirmOpen(true)}>
            {t('memory.aiDrafts.confirm')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDiscardOpen(true)}>
            {t('memory.aiDrafts.discard')}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        title={t('memory.aiDrafts.confirmDialogTitle')}
        description={t('memory.aiDrafts.confirmDialogBody')}
        confirmLabel={t('memory.aiDrafts.confirm')}
        busy={busy}
        onConfirm={() => void confirm()}
        onClose={() => setConfirmOpen(false)}
      />
      <ConfirmDialog
        open={discardOpen}
        title={t('memory.aiDrafts.discardConfirm.title')}
        description={t('memory.aiDrafts.discardConfirm.body')}
        confirmLabel={t('memory.aiDrafts.discard')}
        danger
        busy={busy}
        onConfirm={() => void discard()}
        onClose={() => setDiscardOpen(false)}
      />
    </Card>
  );
}

function AiDraftsPanel({
  memory,
  onMemoryChanged,
}: {
  memory: MemoryView;
  onMemoryChanged: (m: MemoryView) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.memory.aiDrafts(memory.id, { signal }), [api, memory.id]);
  const [asking, setAsking] = useState<MemoryAiDraftKind | null>(null);

  const ask = async (kind: MemoryAiDraftKind) => {
    setAsking(kind);
    try {
      await api.memory.createAiDraft(memory.id, kind);
      state.reload();
    } catch (e) {
      fail(toast, t, e);
    } finally {
      setAsking(null);
    }
  };

  return (
    <div className="stack">
      <p className="muted">{t('memory.aiDrafts.lead')}</p>
      <div className="button-row">
        <Button size="sm" loading={asking === 'title'} onClick={() => void ask('title')}>
          {t('memory.aiDrafts.ask.title')}
        </Button>
        <Button size="sm" loading={asking === 'summary'} onClick={() => void ask('summary')}>
          {t('memory.aiDrafts.ask.summary')}
        </Button>
        <Button size="sm" loading={asking === 'highlights'} onClick={() => void ask('highlights')}>
          {t('memory.aiDrafts.ask.highlights')}
        </Button>
      </div>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('memory.aiDrafts.empty')}</p>
      ) : null}
      {(state.data?.items ?? []).map((d) => (
        <AiDraftRow
          key={d.id}
          d={d}
          memoryId={memory.id}
          onResolved={(m) => {
            state.reload();
            if (m) onMemoryChanged(m);
          }}
        />
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ export
function ExportPanel({ memory }: { memory: MemoryView }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      await api.memory.exportSlideshow(memory.id);
      toast.show({ tone: 'success', title: t('memory.export.created') });
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <p className="muted">{t('memory.export.lead')}</p>
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <Button loading={busy} onClick={() => void create()}>
        {t('memory.export.button')}
      </Button>
    </Card>
  );
}

// ------------------------------------------------------------------ shell
export function MemoryDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const state = useAsync((signal) => api.memory.get(id, { signal }), [api, id]);
  const [tab, setTab] = useState<Tab>('items');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  usePageTitle(state.data?.title, t('app.name'));

  const del = async () => {
    setBusy(true);
    try {
      await api.memory.remove(id);
      toast.show({ tone: 'success', title: t('memory.deleted') });
      router.push('/memory');
    } catch (e) {
      fail(toast, t, e);
      setDeleteOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const memory = state.data;
  if (!memory) return <EmptyState icon={<ImageIcon size={28} />} title={t('memory.notFound')} />;

  return (
    <>
      <PageHeader
        title={memory.title}
        lead={
          <>
            <Badge>{t(KIND_KEYS[memory.kind])}</Badge>
            {memory.aiGenerated ? (
              <span className="muted"> · {t('memory.aiGenerated')}</span>
            ) : null}
          </>
        }
        actions={
          memory.viewer.isOwner ? (
            <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
              {t('memory.delete')}
            </Button>
          ) : undefined
        }
      />

      <FeedTabs
        label={memory.title}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'items', label: t('memory.tab.items') },
          { id: 'links', label: t('memory.tab.links') },
          { id: 'recap', label: t('memory.tab.recap') },
          { id: 'aiDrafts', label: t('memory.tab.aiDrafts') },
          { id: 'export', label: t('memory.tab.export') },
          ...(memory.viewer.isOwner ? [{ id: 'edit', label: t('memory.tab.edit') }] : []),
        ]}
      >
        {tab === 'items' ? (
          <ItemsPanel key="items" memory={memory} onChanged={state.reload} />
        ) : null}
        {tab === 'links' ? (
          <LinksPanel key="links" memory={memory} onChanged={state.reload} />
        ) : null}
        {tab === 'recap' ? (
          <RecapPanel key="recap" memory={memory} onApplied={state.reload} />
        ) : null}
        {tab === 'aiDrafts' ? (
          <AiDraftsPanel key="aiDrafts" memory={memory} onMemoryChanged={(m) => state.setData(m)} />
        ) : null}
        {tab === 'export' ? <ExportPanel key="export" memory={memory} /> : null}
        {tab === 'edit' && memory.viewer.isOwner ? (
          <EditPanel key="edit" memory={memory} onSaved={(m) => state.setData(m)} />
        ) : null}
      </FeedTabs>

      <ConfirmDialog
        open={deleteOpen}
        title={t('memory.deleteConfirm.title')}
        description={t('memory.deleteConfirm.body')}
        confirmLabel={t('memory.delete')}
        danger
        busy={busy}
        onConfirm={() => void del()}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}
