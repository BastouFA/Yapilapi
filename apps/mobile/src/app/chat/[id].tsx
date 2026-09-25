import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { ApiError } from '@yapilapi/api-client';
import { useTheme } from '../../theme';
import { useI18n } from '../../i18n';
import { useAuth } from '../../auth/AuthProvider';
import { usePrefs } from '../../prefs';
import { useOutbox } from '../../offline/OutboxProvider';
import { useConversationSubscription, useRealtime } from '../../realtime/RealtimeProvider';
import { useConversation, useMarkRead, useMessages } from '../../data/inbox';
import { qk } from '../../data/keys';
import { useQueryClient } from '@tanstack/react-query';
import { timeOfDay } from '../../lib/format';
import { buildChatRows, type ChatRow } from '../../features/chat';
import { conversationTitle } from '../(tabs)/inbox';
import {
  AppText,
  Banner,
  Button,
  ConfirmDialog,
  ErrorView,
  LoadingView,
  PagedList,
  Screen,
  TextField,
} from '../../ui';

function Bubble({
  row,
  mine,
  senderName,
  onLongPress,
}: {
  row: ChatRow;
  mine: boolean;
  senderName: string;
  onLongPress: (id: string) => void;
}) {
  const th = useTheme();
  const { t, locale } = useI18n();
  const { retry, discard } = useOutbox();
  const bg = mine ? th.colors.primary : th.colors.surfaceSubtle;
  const fg = mine ? th.colors.onPrimary : th.colors.text;
  const wrap = {
    alignSelf: mine ? ('flex-end' as const) : ('flex-start' as const),
    maxWidth: '82%' as const,
    marginVertical: th.space[1],
    marginHorizontal: th.space[3],
  };

  if (row.kind === 'pending') {
    const failed = row.item.status === 'failed';
    return (
      <View style={wrap}>
        <View
          style={{
            backgroundColor: bg,
            borderRadius: th.radius.md,
            padding: th.space[3],
            opacity: 0.75,
          }}
          accessible
          accessibilityLabel={`${t('chat.messageFromMe', { time: '' })} ${row.item.body}. ${failed ? t('chat.sendFailed') : t('chat.sending')}`}
        >
          <AppText variant="body" style={{ color: fg }}>
            {row.item.body}
          </AppText>
        </View>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: th.space[2],
          }}
        >
          <AppText variant="caption" tone={failed ? 'danger' : 'subtle'}>
            {failed ? t('chat.sendFailed') : t('chat.sending')}
          </AppText>
          {failed || row.item.attempts > 0 ? (
            <Button
              label={t('state.queuedRetry')}
              compact
              variant="ghost"
              onPress={() => void retry(row.item.id)}
            />
          ) : null}
          {failed ? (
            <Button
              label={t('state.queuedDiscard')}
              compact
              variant="ghost"
              onPress={() => void discard(row.item.id)}
            />
          ) : null}
        </View>
      </View>
    );
  }
  const m = row.message;
  const time = timeOfDay(m.createdAt, locale);
  if (m.deleted) {
    return (
      <View style={wrap}>
        <AppText variant="caption" tone="subtle" style={{ fontStyle: 'italic' }}>
          {t('chat.deleted')}
        </AppText>
      </View>
    );
  }
  return (
    <View style={wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={mine ? t('chat.deleteMessage') : undefined}
        accessibilityLabel={`${mine ? t('chat.messageFromMe', { time }) : t('chat.messageFrom', { name: senderName, time })}. ${m.body}`}
        onLongPress={mine ? () => onLongPress(m.id) : undefined}
        style={{ backgroundColor: bg, borderRadius: th.radius.md, padding: th.space[3] }}
      >
        {!mine && m.sender ? (
          <AppText variant="caption" style={{ color: th.colors.primaryText, fontWeight: '700' }}>
            {senderName}
          </AppText>
        ) : null}
        {m.replyTo ? (
          <AppText variant="caption" numberOfLines={1} style={{ color: fg, opacity: 0.7 }}>
            {m.replyTo.deleted ? t('chat.deleted') : m.replyTo.body}
          </AppText>
        ) : null}
        {m.body ? (
          <AppText variant="body" style={{ color: fg }} selectable>
            {m.body}
          </AppText>
        ) : null}
        {m.attachments.length ? (
          <AppText
            variant="caption"
            style={{ color: fg, opacity: 0.8 }}
          >{`${t('chat.attachment')} (${m.attachments.length})`}</AppText>
        ) : null}
      </Pressable>
      <AppText
        variant="caption"
        tone="subtle"
        style={{ alignSelf: mine ? 'flex-end' : 'flex-start' }}
      >{`${time}${m.editedAt ? ` · ${t('chat.edited')}` : ''}`}</AppText>
    </View>
  );
}

export default function Chat() {
  const th = useTheme();
  const { t } = useI18n();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, api } = useAuth();
  const { lowBandwidth } = usePrefs();
  const qc = useQueryClient();
  const conv = useConversation(id);
  const msgs = useMessages(id);
  const { items: outbox, sendMessage } = useOutbox();
  const { client, status } = useRealtime();
  const markRead = useMarkRead(id);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastTyping = useRef(0);
  useConversationSubscription(id);

  // Typing indicators from other members expire after 5 seconds without a refresh.
  useEffect(() => {
    if (!client) return;
    const off = client.on((e) => {
      const ev = e as { type: string; conversationId?: string; userId?: string; state?: string };
      if (ev.type !== 'typing' || ev.conversationId !== id || !ev.userId || ev.userId === user?.id)
        return;
      setTyping((cur) => {
        const next = { ...cur };
        if (ev.state === 'start') next[ev.userId!] = Date.now() + 5000;
        else delete next[ev.userId!];
        return next;
      });
    });
    const timer = setInterval(
      () =>
        setTyping((cur) => {
          const now = Date.now();
          const next = Object.fromEntries(Object.entries(cur).filter(([, until]) => until > now));
          return Object.keys(next).length === Object.keys(cur).length ? cur : next;
        }),
      1500,
    );
    return () => {
      off();
      clearInterval(timer);
    };
  }, [client, id, user?.id]);

  // Mark the conversation read whenever the newest delivered message changes while the screen is open.
  const newestId = msgs.items[0]?.id;
  useEffect(() => {
    if (newestId) markRead.mutate(newestId); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestId]);

  if (conv.isPending)
    return (
      <Screen>
        <LoadingView />
      </Screen>
    );
  if (conv.isError)
    return (
      <Screen>
        <ErrorView error={conv.error} onRetry={() => void conv.refetch()} />
      </Screen>
    );
  const c = conv.data;
  const title = conversationTitle(
    {
      kind: c.kind === 'direct' ? 'direct' : c.kind,
      peer: c.peer ?? null,
      title: c.title,
      channelName: c.channelName,
    },
    t('inbox.group'),
  );
  const memberName = (uid: string | null) =>
    c.members?.find((m) => m.userId === uid)?.profile?.displayName ?? c.peer?.displayName ?? '';
  const rows = buildChatRows(msgs.items, outbox, id);
  const typingNames = Object.keys(typing).map(memberName).filter(Boolean);

  const onChange = (v: string) => {
    setText(v);
    const now = Date.now();
    if (v && client && status === 'open' && now - lastTyping.current > 3000) {
      lastTyping.current = now;
      client.typing(id, 'start');
    }
  };
  const send = () => {
    const body = text.trim();
    if (!body || !c.canSend) return;
    setText('');
    setError(null);
    client?.typing(id, 'stop');
    sendMessage(id, body).catch(() => {
      setText(body);
      setError(t('error.generic'));
    });
  };
  const deleteMessage = async () => {
    const mid = menuFor;
    setMenuFor(null);
    if (!mid) return;
    try {
      await api.messages.delete(mid);
      void qc.invalidateQueries({ queryKey: qk.messages(id) });
    } catch (e) {
      setError(e instanceof ApiError && e.retryable ? t('state.offlineRetry') : t('error.generic'));
    }
  };

  return (
    <Screen edges={['left', 'right', 'bottom']} padded={false}>
      <Stack.Screen options={{ title }} />
      {status !== 'open' ? (
        <Banner
          tone="warning"
          text={status === 'connecting' ? t('chat.connecting') : t('chat.offlineLive')}
        />
      ) : null}
      <PagedList<ChatRow>
        query={{ ...msgs, items: rows }}
        onRefresh={() => msgs.refetch()}
        inverted
        showEnd={false}
        manualPaging={lowBandwidth}
        renderItem={({ item }) => {
          const mine = item.kind === 'pending' || item.message.senderId === user?.id;
          return (
            <Bubble
              row={item}
              mine={mine}
              senderName={
                item.kind === 'message'
                  ? (item.message.sender?.displayName ?? memberName(item.message.senderId))
                  : ''
              }
              onLongPress={setMenuFor}
            />
          );
        }}
        empty={
          <View style={{ transform: [{ scaleY: -1 }], padding: th.space[8] }}>
            <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>
              {t('chat.empty')}
            </AppText>
          </View>
        }
      />
      {typingNames.length ? (
        <AppText
          variant="caption"
          tone="muted"
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: th.space[4] }}
        >
          {t('chat.typing', { name: typingNames.join(', ') })}
        </AppText>
      ) : null}
      {error ? (
        <AppText
          variant="caption"
          tone="danger"
          accessibilityRole="alert"
          style={{ paddingHorizontal: th.space[4] }}
        >
          {error}
        </AppText>
      ) : null}
      {c.canSend ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: th.colors.border,
            backgroundColor: th.colors.surface,
            padding: th.space[3],
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: th.space[2],
          }}
        >
          <View style={{ flex: 1 }}>
            <TextField
              label={t('chat.placeholder')}
              value={text}
              onChangeText={onChange}
              multiline
              multilineHeight={44}
              maxLength={4000}
            />
          </View>
          <Button
            label={t('chat.send')}
            accessibilityLabel={t('chat.send')}
            icon="send"
            disabled={!text.trim()}
            onPress={send}
            style={{ marginBottom: th.space[4] }}
          />
        </View>
      ) : (
        <AppText
          variant="caption"
          tone="muted"
          style={{ padding: th.space[4], textAlign: 'center' }}
        >
          {t('chat.cannotSend')}
        </AppText>
      )}
      <ConfirmDialog
        visible={menuFor !== null}
        title={t('chat.deleteTitle')}
        body={t('chat.deleteBody')}
        confirmLabel={t('chat.deleteMessage')}
        destructive
        onCancel={() => setMenuFor(null)}
        onConfirm={() => void deleteMessage()}
      />
    </Screen>
  );
}
