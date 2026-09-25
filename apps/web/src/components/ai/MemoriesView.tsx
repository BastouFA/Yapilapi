'use client';

import { useState } from 'react';
import {
  Button,
  Card,
  EmptyState,
  IconButton,
  Input,
  SparkIcon,
  TrashIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ConfirmDialog, ErrorView, PageSpinner } from '@/components/common';

/** Everything the assistant remembers about you: transparent, opt-in, and deletable at any time. */
export function MemoriesView() {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  usePageTitle(t('ai.memories.title'), t('app.name'));

  const state = useAsync((signal) => api.ai.memories({ signal }), [api]);
  const [content, setContent] = useState('');
  const [adding, setAdding] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteAllOpen, setDeleteAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const add = async () => {
    const text = content.trim();
    if (!text) return;
    setAdding(true);
    try {
      await api.ai.createMemory({ content: text, source: 'user_stated' });
      setContent('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setAdding(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try {
      await api.ai.deleteMemory(id);
      state.setData((d) => (d ? { ...d, items: d.items.filter((m) => m.id !== id) } : d));
      setDeleteId(null);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    setBusy(true);
    try {
      await api.ai.deleteAllMemories();
      state.setData((d) => (d ? { ...d, items: [] } : d));
      setDeleteAllOpen(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const d = state.data;
  if (!d) return null;

  return (
    <>
      <PageHeader
        title={t('ai.memories.title')}
        lead={d.howItWorks}
        actions={
          d.items.length > 0 ? (
            <Button variant="ghost" size="sm" onClick={() => setDeleteAllOpen(true)}>
              {t('ai.memories.deleteAll')}
            </Button>
          ) : undefined
        }
      />
      {!d.enabled ? (
        <p className="yl-notice yl-notice--info">{t('ai.memories.disabledNotice')}</p>
      ) : !d.consented ? (
        <p className="yl-notice yl-notice--info">{t('ai.memories.consentNeeded')}</p>
      ) : null}

      <Card padding="md" className="inline-form">
        <Input
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('ai.memories.addPlaceholder')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button size="sm" loading={adding} disabled={!content.trim()} onClick={() => void add()}>
          {t('ai.memories.addSubmit')}
        </Button>
      </Card>

      {d.items.length === 0 ? (
        <EmptyState icon={<SparkIcon size={28} />} title={t('ai.memories.empty')} />
      ) : (
        <ul className="stack-sm">
          {d.items.map((m) => (
            <li key={m.id}>
              <Card padding="md" className="search-row">
                <span className="search-row__text">
                  <span>{m.content}</span>
                  <span className="muted">
                    {t(`ai.memories.source.${m.source}`)}
                    {' · '}
                    {m.lastUsedAt
                      ? t('ai.memories.lastUsed', { when: fmt.relative(m.lastUsedAt) })
                      : t('ai.memories.neverUsed')}
                  </span>
                </span>
                <IconButton
                  label={t('ai.memories.delete')}
                  icon={<TrashIcon size={16} />}
                  onClick={() => setDeleteId(m.id)}
                />
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleteId !== null}
        title={t('ai.memories.deleteDialogTitle')}
        description={t('ai.memories.deleteDialogBody')}
        confirmLabel={t('ai.memories.delete')}
        danger
        busy={busy}
        onConfirm={() => deleteId && void remove(deleteId)}
        onClose={() => setDeleteId(null)}
      />
      <ConfirmDialog
        open={deleteAllOpen}
        title={t('ai.memories.deleteAllDialogTitle')}
        description={t('ai.memories.deleteAllDialogBody')}
        confirmLabel={t('ai.memories.deleteAll')}
        danger
        busy={busy}
        onConfirm={() => void removeAll()}
        onClose={() => setDeleteAllOpen(false)}
      />
    </>
  );
}
