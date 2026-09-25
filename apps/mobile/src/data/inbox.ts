import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboxItem, Message } from '@yapilapi/api-client';
import { useApi } from '../auth/AuthProvider';
import { qk } from './keys';
import { usePaged } from './paged';
import { upsertMessage } from './cache';

export function useConversations() {
  const api = useApi();
  return usePaged<InboxItem>(qk.conversations(), (cursor, signal) =>
    api.conversations.list({ ...(cursor ? { cursor } : {}), limit: 30, signal }),
  );
}
export function useConversation(id: string) {
  const api = useApi();
  return useQuery({
    queryKey: qk.conversation(id),
    queryFn: ({ signal }) => api.conversations.get(id, { signal }),
  });
}
/** Messages come newest-first from the API; the chat list is inverted so index 0 is the bottom. */
export function useMessages(id: string) {
  const api = useApi();
  return usePaged<Message>(qk.messages(id), (cursor, signal) =>
    api.conversations.messages(id, { ...(cursor ? { cursor } : {}), limit: 30, signal }),
  );
}
export function useUnreadConversations() {
  const api = useApi();
  return useQuery({
    queryKey: qk.unreadConversations(),
    queryFn: ({ signal }) => api.conversations.unreadCount({ signal }),
    refetchInterval: 60_000,
  });
}
export function useMarkRead(id: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (messageId?: string) => api.conversations.markRead(id, messageId),
    onSuccess: () => {
      qc.setQueryData<{ pages: Array<{ items: InboxItem[] }>; pageParams: unknown[] }>(
        qk.conversations(),
        (old) =>
          old && {
            ...old,
            pages: old.pages.map((pg) => ({
              ...pg,
              items: pg.items.map((c) => (c.id === id ? { ...c, unreadCount: 0 } : c)),
            })),
          },
      );
      void qc.invalidateQueries({ queryKey: qk.unreadConversations() });
    },
  });
}
export function useStartDirect() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.conversations.direct({ username }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.conversations() });
    },
  });
}
export { upsertMessage };
