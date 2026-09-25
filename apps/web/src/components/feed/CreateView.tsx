'use client';

import { useRouter } from 'next/navigation';
import { ApiError, type CreatePostInput } from '@yapilapi/api-client';
import { Composer, useToast, type ComposerValue, type ComposerVisibility } from '@yapilapi/ui';
import { useI18n } from '@/i18n';
import { useApi } from '@/lib/api';
import { useAsync, usePageTitle } from '@/lib/hooks';
import { useComposerLabels } from '@/lib/labels';
import { useSession } from '@/lib/session';
import { usePreferences } from '@/lib/preferences';
import { describeError } from '@/lib/errors';
import { requestCoarsePosition } from '@/lib/geo';
import { useMediaUploads } from '@/lib/use-media-uploads';
import { PageHeader } from '@/components/PageHeader';
import { ErrorView, PageSpinner } from '@/components/common';

const VISIBLE: ComposerVisibility[] = ['public', 'followers', 'friends', 'private'];

export function CreateView() {
  const api = useApi();
  const { t } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const { isTeen } = useSession();
  const { saved, loading: prefsLoading } = usePreferences();
  const labels = useComposerLabels();
  const media = useMediaUploads();
  usePageTitle(t('create.title'), t('app.name'));

  const data = useAsync(
    async (signal) => {
      const [topics, circles] = await Promise.all([
        api.topics.list({ signal }),
        api.graph.circles({ signal }),
      ]);
      return { topics: topics.items, circles: circles.items };
    },
    [api],
  );

  const fallback: ComposerVisibility = 'followers';
  const preferred =
    saved && VISIBLE.includes(saved.defaultPostVisibility as ComposerVisibility)
      ? (saved.defaultPostVisibility as ComposerVisibility)
      : fallback;
  const defaultVisibility: ComposerVisibility =
    isTeen && preferred === 'public' ? 'followers' : preferred;

  const submit = async (v: ComposerValue) => {
    const input: CreatePostInput = { visibility: v.visibility };
    if (v.body.trim()) input.body = v.body.trim();
    if (v.circleId) input.circleId = v.circleId;
    if (v.audience?.length) input.audience = v.audience;
    if (v.topics?.length) input.topics = v.topics;
    if (v.poll) input.poll = v.poll;
    if (v.linkUrl) input.linkUrl = v.linkUrl;
    if (v.mediaIds?.length) input.mediaIds = v.mediaIds;
    if (v.latitude !== undefined && v.longitude !== undefined) {
      input.latitude = v.latitude;
      input.longitude = v.longitude;
    }
    try {
      const post = await api.posts.create(input);
      media.reset();
      toast.show({ tone: 'success', title: t('create.posted') });
      router.push(`/post/${post.id}`);
    } catch (e) {
      const d = describeError(e, t);
      // Field-level API messages are specific and useful (for example a rejected link); keep them.
      const first = e instanceof ApiError ? Object.values(d.fields)[0] : undefined;
      throw new Error(first ? `${d.message} ${first}` : d.message);
    }
  };

  const lookup = async (username: string) => {
    try {
      const p = await api.profile.get(username.replace(/^@/, ''));
      return { id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  };

  const locate = async () => {
    const r = await requestCoarsePosition();
    return r.ok ? r.position : null;
  };

  return (
    <>
      <PageHeader title={t('create.title')} lead={t('create.lead')} />
      {data.loading || (prefsLoading && !saved) ? <PageSpinner /> : null}
      {data.error ? <ErrorView error={data.error} onRetry={data.reload} /> : null}
      {data.data && !(prefsLoading && !saved) ? (
        <Composer
          labels={labels}
          topics={data.data.topics}
          circles={data.data.circles}
          isTeen={isTeen}
          defaultVisibility={defaultVisibility}
          onSubmit={submit}
          onLookupUser={lookup}
          onRequestLocation={locate}
          circlesHref="/settings/connections"
          media={media.items}
          onAddMedia={media.addFiles}
          onRemoveMedia={media.remove}
          onSetMediaAltText={media.setAltText}
          maxMedia={media.maxItems}
        />
      ) : null}
    </>
  );
}
