'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { StudioProject, StudioSuggestionKind } from '@yapilapi/api-client';
import {
  Button,
  Card,
  EmptyState,
  FeedTabs,
  FormField,
  Input,
  Select,
  Textarea,
  VideoIcon,
  useToast,
} from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { describeError } from '@/lib/errors';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner, ConfirmDialog } from '@/components/common';

type Tab = 'edit' | 'captions' | 'suggestions' | 'render' | 'publish';

const SUGGESTION_KINDS: StudioSuggestionKind[] = [
  'title',
  'description',
  'thumbnail',
  'silence_cuts',
  'highlights',
  'captions_review',
];
const SUGGESTION_KIND_KEYS = {
  title: 'studio.suggestions.kind.title',
  description: 'studio.suggestions.kind.description',
  thumbnail: 'studio.suggestions.kind.thumbnail',
  silence_cuts: 'studio.suggestions.kind.silence_cuts',
  highlights: 'studio.suggestions.kind.highlights',
  captions_review: 'studio.suggestions.kind.captions_review',
} as const satisfies Record<StudioSuggestionKind, string>;
const SUGGESTION_STATUS_KEYS = {
  suggested: 'studio.suggestions.status.suggested',
  accepted: 'studio.suggestions.status.accepted',
  dismissed: 'studio.suggestions.status.dismissed',
} as const;
const RENDER_STATUS_KEYS = {
  queued: 'studio.render.status.queued',
  running: 'studio.render.status.running',
  done: 'studio.render.status.done',
  failed: 'studio.render.status.failed',
} as const;
const PUBLICATION_STATUS_KEYS = {
  confirmed: 'studio.publish.status.confirmed',
  published: 'studio.publish.status.published',
  cancelled: 'studio.publish.status.cancelled',
  stale: 'studio.publish.status.stale',
  failed: 'studio.publish.status.failed',
} as const;

// ------------------------------------------------------------------ EDL editor
function EditPanel({ project, onSaved }: { project: StudioProject; onSaved: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [text, setText] = useState(() => JSON.stringify(project.edl, null, 2));
  const [issues, setIssues] = useState<Array<{ path: string; message: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const parse = (): unknown | undefined => {
    try {
      return JSON.parse(text);
    } catch {
      setError(t('studio.edl.invalidJson'));
      return undefined;
    }
  };

  const validate = async () => {
    const edl = parse();
    if (edl === undefined) return;
    setBusy(true);
    setError('');
    setIssues([]);
    try {
      const r = await api.studio.validateEdl({ edl, durationMs: 3_600_000 });
      if (r.valid) toast.show({ tone: 'success', title: t('studio.edl.valid') });
      else setIssues(r.issues);
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const edl = parse();
    if (edl === undefined) return;
    setBusy(true);
    setError('');
    setIssues([]);
    try {
      await api.studio.setEdl(project.id, edl, project.edlVersion);
      toast.show({ tone: 'success', title: t('studio.edl.saved') });
      onSaved();
    } catch (e) {
      const conflict = describeError(e, t).code === 'conflict';
      setError(conflict ? t('studio.edl.conflict') : describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padding="md" className="stack-sm">
      <h4 className="section-title">{t('studio.edl.title')}</h4>
      <p className="muted">{t('studio.edl.help')}</p>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        style={{ fontFamily: 'monospace' }}
      />
      {issues.length > 0 ? (
        <ul className="stack-sm">
          {issues.map((i, idx) => (
            <li key={idx} className="yl-notice yl-notice--danger">
              {t('studio.edl.issue', { path: i.path, message: i.message })}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="yl-notice yl-notice--danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void validate()}>
          {t('studio.edl.validate')}
        </Button>
        <Button size="sm" loading={busy} onClick={() => void save()}>
          {t('studio.edl.save')}
        </Button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ captions
function CaptionsPanel({ projectId }: { projectId: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync(
    (signal) => api.studio.captionTracks(projectId, { signal }),
    [api, projectId],
  );
  const [lang, setLang] = useState('en');
  const [format, setFormat] = useState<'vtt' | 'srt'>('vtt');
  const [text, setText] = useState('');
  const [transcribeLang, setTranscribeLang] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fail = (e: unknown) => setError(describeError(e, t).message);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.studio.putCaptionTrack(projectId, lang.trim(), {
        [format]: text,
      } as { vtt?: string; srt?: string });
      toast.show({ tone: 'success', title: t('studio.captions.saved') });
      setText('');
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (l: string) => {
    setBusy(true);
    try {
      await api.studio.deleteCaptionTrack(projectId, l);
      toast.show({ tone: 'success', title: t('studio.captions.deleted') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const transcribe = async () => {
    setBusy(true);
    setError('');
    try {
      await api.studio.transcribe(projectId, transcribeLang.trim() || undefined);
      toast.show({ tone: 'success', title: t('studio.captions.transcribed') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <FormField label={t('studio.captions.lang')}>
          <Input value={lang} onChange={(e) => setLang(e.target.value)} />
        </FormField>
        <FormField label={t('studio.captions.format')}>
          <Select value={format} onChange={(e) => setFormat(e.target.value as 'vtt' | 'srt')}>
            <option value="vtt">{t('studio.captions.format.vtt')}</option>
            <option value="srt">{t('studio.captions.format.srt')}</option>
          </Select>
        </FormField>
        <FormField label={t('studio.captions.text')}>
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} />
        </FormField>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button size="sm" loading={busy} onClick={() => void save()}>
          {t('studio.captions.save')}
        </Button>
      </Card>

      <Card padding="md" className="stack-sm">
        <FormField label={t('studio.captions.transcribeLanguage')}>
          <Input value={transcribeLang} onChange={(e) => setTranscribeLang(e.target.value)} />
        </FormField>
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void transcribe()}>
          {t('studio.captions.transcribe')}
        </Button>
      </Card>

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('studio.captions.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((tr) => (
            <li key={tr.lang} className="search-row">
              <span className="search-row__text">
                <span>{tr.lang}</span>
                <span className="muted">
                  {t('studio.captions.cueCount', { count: tr.cues })} · {tr.source}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => void remove(tr.lang)}>
                {t('studio.captions.delete')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ suggestions
function SuggestionsPanel({ projectId, onApplied }: { projectId: string; onApplied: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync(
    (signal) => api.studio.suggestions(projectId, { signal }),
    [api, projectId],
  );
  const [busy, setBusy] = useState(false);
  const [skipped, setSkipped] = useState<Array<{ kind: string; reason: string }>>([]);

  const fail = (e: unknown) =>
    toast.show({
      tone: 'danger',
      title: t('error.actionFailed'),
      description: describeError(e, t).message,
    });

  const generate = async () => {
    setBusy(true);
    try {
      const r = await api.studio.generateSuggestions(projectId, { kinds: SUGGESTION_KINDS });
      setSkipped(r.skipped);
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const accept = async (sid: string) => {
    setBusy(true);
    try {
      await api.studio.acceptSuggestion(projectId, sid);
      toast.show({ tone: 'success', title: t('studio.suggestions.accepted') });
      state.reload();
      onApplied();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async (sid: string) => {
    setBusy(true);
    try {
      await api.studio.dismissSuggestion(projectId, sid);
      toast.show({ tone: 'success', title: t('studio.suggestions.dismissed') });
      state.reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="muted">{t('studio.suggestions.lead')}</p>
      <Button size="sm" loading={busy} onClick={() => void generate()}>
        {t('studio.suggestions.generate')}
      </Button>
      {skipped.length > 0 ? (
        <ul className="stack-sm">
          {skipped.map((s, i) => (
            <li key={i} className="muted">
              {t('studio.suggestions.skipped', { kind: s.kind, reason: s.reason })}
            </li>
          ))}
        </ul>
      ) : null}

      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('studio.suggestions.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((s) => (
            <li key={s.id} className="search-row">
              <span className="search-row__text">
                <span>{t(SUGGESTION_KIND_KEYS[s.kind])}</span>
                <span className="muted">{t(SUGGESTION_STATUS_KEYS[s.status])}</span>
              </span>
              {s.status === 'suggested' ? (
                <span className="button-row">
                  <Button size="sm" loading={busy} onClick={() => void accept(s.id)}>
                    {t('studio.suggestions.accept')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy}
                    onClick={() => void dismiss(s.id)}
                  >
                    {t('studio.suggestions.dismiss')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ render
function RenderPanel({ project, onRendered }: { project: StudioProject; onRendered: () => void }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.studio.renders(project.id, { signal }), [api, project.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const render = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.studio.render(project.id);
      toast.show({
        tone: 'success',
        title: r.reused ? t('studio.render.reused') : t('studio.render.started'),
      });
      state.reload();
      onRendered();
    } catch (e) {
      setError(describeError(e, t).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <p className="muted">{t('studio.render.help')}</p>
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button loading={busy} onClick={() => void render()}>
          {t('studio.render.start')}
        </Button>
      </Card>

      <h4 className="section-title">{t('studio.render.history')}</h4>
      {state.loading ? <PageSpinner /> : null}
      {state.error ? <ErrorView error={state.error} onRetry={state.reload} /> : null}
      {state.data && state.data.items.length === 0 ? (
        <p className="muted">{t('studio.render.empty')}</p>
      ) : null}
      {state.data && state.data.items.length > 0 ? (
        <ul className="stack-sm">
          {state.data.items.map((j) => (
            <li key={j.id} className="muted">
              {t(
                RENDER_STATUS_KEYS[j.status as keyof typeof RENDER_STATUS_KEYS] ??
                  'studio.render.status.queued',
              )}
              {j.errorCode ? ` · ${j.errorCode}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ publish
function PublishPanel({ project }: { project: StudioProject }) {
  const api = useApi();
  const { t, fmt } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const pub = useAsync(
    (signal) => api.studio.publication(project.id, { signal }),
    [api, project.id],
  );
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<'now' | 'scheduled'>('now');
  const [publishAt, setPublishAt] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const publish = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.studio.publish(project.id, {
        confirm: true,
        mode,
        publishAt: mode === 'scheduled' ? new Date(publishAt).toISOString() : undefined,
        body,
      });
      toast.show({
        tone: 'success',
        title: mode === 'now' ? t('studio.publish.published') : t('studio.publish.scheduled'),
      });
      setConfirmOpen(false);
      pub.reload();
      if (r.postId) router.push(`/p/${encodeURIComponent(r.postId)}`);
    } catch (e) {
      setError(describeError(e, t).message);
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      await api.studio.cancelPublication(project.id);
      toast.show({ tone: 'success', title: t('studio.publish.cancelled') });
      pub.reload();
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

  const current = pub.data?.publication;

  return (
    <div className="stack">
      <Card padding="md" className="stack-sm">
        <p className="muted">{t('studio.publish.help')}</p>
        {!project.rendered ? <p className="muted">{t('studio.publish.needsRender')}</p> : null}
        <FormField label={t('studio.publish.body')}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
        </FormField>
        <FormField label={t('studio.publish.mode')}>
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'now' | 'scheduled')}>
            <option value="now">{t('studio.publish.mode.now')}</option>
            <option value="scheduled">{t('studio.publish.mode.scheduled')}</option>
          </Select>
        </FormField>
        {mode === 'scheduled' ? (
          <FormField label={t('studio.publish.publishAt')}>
            <Input
              type="datetime-local"
              value={publishAt}
              onChange={(e) => setPublishAt(e.target.value)}
            />
          </FormField>
        ) : null}
        {error ? (
          <p className="yl-notice yl-notice--danger" role="alert">
            {error}
          </p>
        ) : null}
        <Button onClick={() => setConfirmOpen(true)}>{t('studio.publish.confirm')}</Button>
      </Card>

      <h4 className="section-title">{t('studio.publish.current')}</h4>
      {pub.loading ? <PageSpinner /> : null}
      {!pub.loading && !current ? <p className="muted">{t('studio.publish.none')}</p> : null}
      {current ? (
        <Card padding="md" className="stack-sm">
          <p>
            {t(
              PUBLICATION_STATUS_KEYS[current.status as keyof typeof PUBLICATION_STATUS_KEYS] ??
                'studio.publish.status.confirmed',
            )}
          </p>
          {current.publishAt ? <p className="muted">{fmt.dateTime(current.publishAt)}</p> : null}
          {current.status === 'confirmed' ? (
            <Button size="sm" variant="ghost" loading={busy} onClick={() => void cancel()}>
              {t('studio.publish.cancel')}
            </Button>
          ) : null}
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        title={t('studio.publish.confirmDialog.title')}
        description={t('studio.publish.confirmDialog.body')}
        confirmLabel={t('studio.publish.confirm')}
        busy={busy}
        onConfirm={() => void publish()}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ shell
export function ProjectDetailView({ id }: { id: string }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const state = useAsync((signal) => api.studio.project(id, { signal }), [api, id]);
  const [tab, setTab] = useState<Tab>('edit');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  usePageTitle(state.data?.title, t('app.name'));

  const remove = async () => {
    setBusy(true);
    try {
      await api.studio.deleteProject(id);
      toast.show({ tone: 'success', title: t('studio.projects.deleted') });
      router.push('/studio');
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

  if (state.loading) return <PageSpinner />;
  if (state.error) return <ErrorView error={state.error} onRetry={state.reload} />;
  const project = state.data;
  if (!project)
    return <EmptyState icon={<VideoIcon size={28} />} title={t('studio.projects.notFound')} />;

  return (
    <>
      <PageHeader
        title={project.title}
        actions={
          <Button size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
            {t('studio.projects.delete')}
          </Button>
        }
      />
      <FeedTabs
        label={project.title}
        value={tab}
        onChange={(v) => setTab(v as Tab)}
        tabs={[
          { id: 'edit', label: t('studio.tab.edit') },
          { id: 'captions', label: t('studio.tab.captions') },
          { id: 'suggestions', label: t('studio.tab.suggestions') },
          { id: 'render', label: t('studio.tab.render') },
          { id: 'publish', label: t('studio.tab.publish') },
        ]}
      >
        {tab === 'edit' ? <EditPanel key="edit" project={project} onSaved={state.reload} /> : null}
        {tab === 'captions' ? <CaptionsPanel key="captions" projectId={project.id} /> : null}
        {tab === 'suggestions' ? (
          <SuggestionsPanel key="suggestions" projectId={project.id} onApplied={state.reload} />
        ) : null}
        {tab === 'render' ? (
          <RenderPanel key="render" project={project} onRendered={state.reload} />
        ) : null}
        {tab === 'publish' ? <PublishPanel key="publish" project={project} /> : null}
      </FeedTabs>

      <ConfirmDialog
        open={deleteOpen}
        title={t('studio.projects.deleteConfirm.title')}
        description={t('studio.projects.deleteConfirm.body')}
        confirmLabel={t('studio.projects.delete')}
        danger
        busy={busy}
        onConfirm={() => void remove()}
        onClose={() => setDeleteOpen(false)}
      />
    </>
  );
}
