import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { Message, Post } from '@yapilapi/api-client';

type PostLike = { id: string };
type PagesOf<T> = InfiniteData<{ items: T[]; nextCursor?: string | null }>;
const POST_DOMAINS = new Set(['feed', 'post', 'userPosts', 'communityFeed', 'trending', 'saved']);

const isPages = (v: unknown): v is PagesOf<PostLike> =>
  !!v && typeof v === 'object' && Array.isArray((v as { pages?: unknown }).pages);

/** Apply `fn` to a post wherever it is cached (feeds, detail, profile, community, trending). */
export function patchPost(qc: QueryClient, postId: string, fn: (p: Post) => Post): void {
  qc.setQueriesData(
    { predicate: (q) => POST_DOMAINS.has(String(q.queryKey[0])) },
    (old: unknown) => {
      if (isPages(old)) {
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.map((it) => (it.id === postId ? fn(it as Post) : it)),
          })),
        };
      }
      if (
        old &&
        typeof old === 'object' &&
        (old as PostLike).id === postId &&
        'counts' in (old as object)
      )
        return fn(old as Post);
      return old;
    },
  );
}

/** Remove a post from every list (hidden, deleted, "not interested"). */
export function removePost(qc: QueryClient, postId: string): void {
  qc.setQueriesData(
    { predicate: (q) => POST_DOMAINS.has(String(q.queryKey[0])) && q.queryKey[0] !== 'post' },
    (old: unknown) => {
      if (isPages(old))
        return {
          ...old,
          pages: old.pages.map((pg) => ({
            ...pg,
            items: pg.items.filter((it) => it.id !== postId),
          })),
        };
      return old;
    },
  );
}

/** Insert a message at the head of a conversation's (newest-first) cache unless it is already there. */
export function upsertMessage(qc: QueryClient, conversationId: string, msg: Message): void {
  qc.setQueryData<PagesOf<Message>>(['messages', conversationId], (old) => {
    if (!old) return old;
    const exists = old.pages.some((pg) => pg.items.some((m) => m.id === msg.id));
    if (exists)
      return {
        ...old,
        pages: old.pages.map((pg) => ({
          ...pg,
          items: pg.items.map((m) => (m.id === msg.id ? msg : m)),
        })),
      };
    const [first, ...rest] = old.pages;
    return first ? { ...old, pages: [{ ...first, items: [msg, ...first.items] }, ...rest] } : old;
  });
}

export function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

export function flatten<T extends { id: string }>(
  data: InfiniteData<{ items: T[] }> | undefined,
): T[] {
  return data ? dedupeById(data.pages.flatMap((p) => p.items)) : [];
}
