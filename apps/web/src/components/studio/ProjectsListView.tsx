'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { ApiError } from '@yapilapi/api-client';
import {
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Textarea,
  VideoIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';

const PROJECT_STATUS_KEYS = {
  draft: 'studio.projects.status.draft',
  published: 'studio.projects.status.published',
} as const;

export function ProjectsListView() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  usePageTitle(t('studio.title'), t('app.name'));
  const state = useAsync((signal) => api.studio.projects({ signal }), [api]);
  const status = useAsync((signal) => api.studio.status({ signal }), [api]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [uploadedMediaId, setUploadedMediaId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const pickFile = async (file: File) => {
    setUploading(true);
    setError('');
    try {
      const media = await api.media.upload(file, { fileName: file.name, purpose: 'attachment' });
      setUploadedMediaId(media.id);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setUploading(false);
    }
  };

  const create = async () => {
    if (!uploadedMediaId) return;
    setCreating(true);
    setError('');
    try {
      await api.studio.createProject({
        title: title.trim(),
        description: description.trim() || undefined,
        mediaId: uploadedMediaId,
      });
      toast.show({ tone: 'success', title: t('studio.projects.created') });
      setTitle('');
      setDescription('');
      setUploadedMediaId(null);
      if (fileInput.current) fileInput.current.value = '';
      state.reload();
    } catch (e) {
      const reason =
        e instanceof ApiError ? (e.details as { reason?: string } | undefined)?.reason : undefined;
      if (reason === 'source_not_ready') {
        setError(t('studio.projects.sourceNotReady'));
      } else {
        setError(describeError(e, t).message);
      }
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <PageHeader title={t('studio.title')} lead={t('studio.lead')} />

      {status.data && !status.data.render.available ? (
        <p className="yl-notice" role="status">
          {t('studio.unavailable.render')}
        </p>
      ) : null}

      <Card padding="md" className="stack-sm">
        <h3 className="section-title">{t('studio.projects.new')}</h3>
        <FormField label={t('studio.projects.uploadFile')}>
          <Input
            ref={fileInput}
            type="file"
            accept="video/*,audio/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickFile(f);
            }}
          />
        </FormField>
        {uploading ? <p className="muted">{t('studio.projects.uploading')}</p> : null}
        <FormField label={t('studio.projects.title')} required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <FormField label={t('studio.projects.description')}>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </FormField>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button
          loading={creating}
          disabled={!uploadedMediaId || !title.trim() || uploading}
          onClick={() => void create()}
        >
          {error === t('studio.projects.sourceNotReady')
            ? t('studio.projects.retry')
            : t('studio.projects.create')}
        </Button>
      </Card>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <EmptyState icon={<VideoIcon size={28} />} title={t('studio.projects.empty')} />
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((p) => (
            <li key={p.id} className="search-row">
              <Link href={`/studio/${encodeURIComponent(p.id)}`} className="search-row__text">
                <span>{p.title}</span>
                <span className="muted">
                  {t(
                    p.status in PROJECT_STATUS_KEYS
                      ? PROJECT_STATUS_KEYS[p.status as keyof typeof PROJECT_STATUS_KEYS]
                      : 'studio.projects.status.draft',
                  )}
                  {' · '}
                  {p.rendered ? t('studio.projects.rendered') : t('studio.projects.notRendered')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
