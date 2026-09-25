import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../auth/AuthProvider';
import type { AppNotification } from '../api';
import { qk } from './keys';
import { usePaged } from './paged';

export function useNotifications() {
  const api = useApi();
  return usePaged<AppNotification>(qk.notifications(), (cursor, signal) =>
    api.notifications.list({ ...(cursor ? { cursor } : {}), limit: 30, signal }),
  );
}
export function useUnreadNotifications() {
  const api = useApi();
  return useQuery({
    queryKey: qk.unreadNotifications(),
    queryFn: ({ signal }) => api.notifications.unreadCount({ signal }),
    refetchInterval: 60_000,
  });
}
export function useReadAllNotifications() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.notifications.readAll(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notifications() });
      void qc.invalidateQueries({ queryKey: qk.unreadNotifications() });
    },
  });
}
export function useMarkNotificationRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.notifications.markRead(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.notifications() });
      void qc.invalidateQueries({ queryKey: qk.unreadNotifications() });
    },
  });
}
