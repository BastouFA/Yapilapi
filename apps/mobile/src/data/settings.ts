import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Preferences, PreferencesUpdate, UserCard } from '@yapilapi/api-client';
import { useApi, useAuth } from '../auth/AuthProvider';
import { qk } from './keys';

export function usePreferences() {
  const api = useApi();
  return useQuery({
    queryKey: qk.preferences(),
    queryFn: ({ signal }) => api.settings.getPreferences({ signal }),
    staleTime: 5 * 60_000,
  });
}

/** Optimistic: the switch moves immediately and snaps back (with the error) when the server refuses. */
export function useUpdatePreferences() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: PreferencesUpdate) => api.settings.updatePreferences(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: qk.preferences() });
      const prev = qc.getQueryData<Preferences>(qk.preferences());
      if (prev)
        qc.setQueryData<Preferences>(qk.preferences(), { ...prev, ...patch } as Preferences);
      return { prev };
    },
    onError: (_e, _p, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.preferences(), ctx.prev);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.preferences() });
    },
  });
}

export function useSessions() {
  const api = useApi();
  return useQuery({
    queryKey: qk.sessions(),
    queryFn: ({ signal }) => api.auth.sessions({ signal }),
  });
}
export function useRevokeSession() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.auth.revokeSession(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.sessions() });
    },
  });
}

export function useBlocks() {
  const api = useApi();
  return useQuery({ queryKey: ['blocks'], queryFn: ({ signal }) => api.graph.blocks({ signal }) });
}
export function useUnblock() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: UserCard) => api.graph.unblock(u.username),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['blocks'] });
    },
  });
}

export function usePrivacyRequests() {
  const api = useApi();
  return useQuery({
    queryKey: ['privacyRequests'],
    queryFn: ({ signal }) => api.privacy.requests({ signal }),
  });
}
export function useRequestExport() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.privacy.requestExport(password),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['privacyRequests'] });
    },
  });
}

export function usePushTokens() {
  const api = useApi();
  return useQuery({
    queryKey: qk.pushTokens(),
    queryFn: ({ signal }) => api.notifications.pushTokens({ signal }),
  });
}

/** Changing the UI language also stores it as the account language (used for emails), best effort. */
export function useSaveLocaleToAccount() {
  const api = useApi();
  const { refresh } = useAuth();
  return (locale: string) => {
    void api.settings
      .updatePreferences({ locale })
      .then(() => refresh())
      .catch(() => undefined);
  };
}
