import type { Post } from '@yapilapi/api-client';
import type { MobileApi } from '../api';
import { uploadMedia } from '../media/upload';
import type { DraftMedia, OutboxItem, PostDraft, Runner } from './outbox';

export interface HandlerOptions {
  username: string;
  lowBandwidth: () => boolean;
}

/** Look for a post we may already have created whose answer was lost (the API has no idempotency key for posts). */
export async function findPostedDuplicate(
  api: MobileApi,
  username: string,
  draft: PostDraft,
  since: number,
): Promise<Post | null> {
  const page = await api.posts.byUser(username, { limit: 10 });
  const body = (draft.body ?? '').trim();
  return (
    page.items.find(
      (p) =>
        p.body.trim() === body &&
        new Date(p.createdAt).getTime() >= since - 60_000 &&
        (draft.poll ? p.poll !== null : true),
    ) ?? null
  );
}

async function ensureUploaded(
  api: MobileApi,
  m: DraftMedia,
  o: HandlerOptions,
  save: (m: DraftMedia) => Promise<void>,
): Promise<string> {
  if (m.mediaId) return m.mediaId;
  const media = await uploadMedia(
    api,
    { uri: m.uri, name: m.name, mimeType: m.mimeType, size: m.size },
    {
      lowBandwidth: o.lowBandwidth(),
      ...(m.altText ? { altText: m.altText } : {}),
      resumeId: m.uploadId,
      onSession: (id) => {
        m.uploadId = id;
        void save(m);
      },
    },
  );
  m.mediaId = media.id;
  await save(m);
  return media.id;
}

export function createOutboxRunner(api: MobileApi, o: HandlerOptions): Runner {
  return async (item: OutboxItem, update) => {
    if (item.kind === 'message') {
      // The server de-duplicates on clientMessageId, so blind retries are safe.
      return api.conversations.send(item.conversationId, {
        body: item.body,
        clientMessageId: item.clientMessageId,
        ...(item.replyToId ? { replyToId: item.replyToId } : {}),
      });
    }
    const draft = item.draft;
    if (item.maybeSent) {
      const dup = await findPostedDuplicate(api, o.username, draft, item.sentAt ?? item.createdAt);
      if (dup) return dup;
    }
    const mediaIds: string[] = [];
    const media = (draft.media ?? []).map((m) => ({ ...m }));
    for (const m of media) {
      mediaIds.push(
        await ensureUploaded(api, m, o, async () => {
          await update({
            draft: { ...draft, media: media.map((x) => ({ ...x })) },
          } as Partial<OutboxItem>);
        }),
      );
    }
    const { media: _drop, ...rest } = draft;
    void _drop;
    await update({ maybeSent: true, sentAt: Date.now() } as Partial<OutboxItem>);
    return api.posts.create({ ...rest, ...(mediaIds.length ? { mediaIds } : {}) });
  };
}
