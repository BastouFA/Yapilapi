import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import type { Message, RealtimeEvent } from '@yapilapi/api-client';
import { useAuth } from '../auth/AuthProvider';
import { qk } from '../data/keys';
import { upsertMessage } from '../data/cache';
import { RealtimeClient, type RealtimeStatus, type SocketFactory } from './client';

interface RealtimeValue {
  status: RealtimeStatus;
  client: RealtimeClient | null;
}
const RealtimeContext = createContext<RealtimeValue>({ status: 'idle', client: null });

export function RealtimeProvider({
  children,
  socketFactory,
}: {
  children: React.ReactNode;
  socketFactory?: SocketFactory;
}) {
  const { api, status: authStatus, user } = useAuth();
  const qc = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const userId = user?.id;
  const client = useMemo(
    () =>
      authStatus === 'signedIn' && userId
        ? new RealtimeClient({
            baseUrl: api.baseUrl,
            getTicket: () => api.realtime.ticket(),
            ...(socketFactory ? { socketFactory } : {}),
          })
        : null,
    [authStatus, userId, api, socketFactory],
  );
  const appActive = useRef(AppState.currentState !== 'background');

  useEffect(() => {
    if (!client) {
      setStatus('idle');
      return;
    }
    const offStatus = client.onStatus(setStatus);
    const off = client.on((e: RealtimeEvent) => {
      switch (e.type) {
        case 'message.new':
        case 'message.updated': {
          const ev = e as unknown as { conversationId: string; message: Message };
          upsertMessage(qc, ev.conversationId, ev.message as Message);
          void qc.invalidateQueries({ queryKey: qk.conversations() });
          void qc.invalidateQueries({ queryKey: qk.unreadConversations() });
          break;
        }
        case 'message.deleted':
        case 'conversation.updated':
        case 'conversation.read':
          void qc.invalidateQueries({
            queryKey: qk.messages((e as { conversationId: string }).conversationId),
          });
          void qc.invalidateQueries({ queryKey: qk.conversations() });
          break;
        case 'conversation.added':
        case 'conversation.removed':
          void qc.invalidateQueries({ queryKey: qk.conversations() });
          break;
        case 'notification':
          // A new direct conversation arrives only as a generic notification (API gap): refetch the inbox and counters.
          void qc.invalidateQueries({ queryKey: qk.notifications() });
          void qc.invalidateQueries({ queryKey: qk.unreadNotifications() });
          void qc.invalidateQueries({ queryKey: qk.conversations() });
          void qc.invalidateQueries({ queryKey: qk.unreadConversations() });
          break;
        case 'reconnected':
          // The socket has no replay: catch up over REST after any gap.
          void qc.invalidateQueries({ queryKey: ['messages'] });
          void qc.invalidateQueries({ queryKey: qk.conversations() });
          void qc.invalidateQueries({ queryKey: qk.notifications() });
          break;
      }
    });
    if (appActive.current) client.connect();
    const sub = AppState.addEventListener('change', (s) => {
      appActive.current = s === 'active';
      if (s === 'active') client.connect();
      else client.disconnect();
    });
    return () => {
      off();
      offStatus();
      sub.remove();
      client.disconnect();
    };
  }, [client, qc]);

  const value = useMemo(() => ({ status, client }), [status, client]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export const useRealtime = () => useContext(RealtimeContext);

/** Subscribe the socket to one conversation while a chat screen is open. */
export function useConversationSubscription(conversationId: string | undefined): void {
  const { client, status } = useRealtime();
  useEffect(() => {
    if (!client || !conversationId) return;
    client.subscribe(conversationId);
    return () => client.unsubscribe(conversationId);
  }, [client, conversationId, status === 'open']);
}
