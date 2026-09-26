'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AIPanel, Button, ChatBubble, Icon, Menu, Skeleton } from '@yapilapi/design-system';
import type { Conversation, Message } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { ReportSheet } from '@/components/PostList';
import { useRealtime, useSession } from '../../../providers';
import { useCalls } from '@/components/Calls';
import { MiniAppsSheet } from '@/components/MiniApps';
import { MessageAttachments, VoiceRecorder } from '@/components/ChatAttachments';

type Pending = Message & { pending?: boolean };

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const { me, t, toast, locale, setUnread, unread } = useSession();
  const [conv, setConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Pending[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [typing, setTyping] = useState<string | null>(null);
  const [ai, setAi] = useState<{ title: string; text: string; notice?: string; plan?: Record<string, unknown> } | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [reportId, setReportId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const calls = useCalls();
  const [appsOpen, setAppsOpen] = useState(false);

  useEffect(() => {
    api.conversations.get(id).then(
      (r) => setConv(r.conversation),
      (e) => toast(errorMessage(e)),
    );
    api.conversations.messages(id).then(
      (r) => {
        setMessages(r.items);
        setCursor(r.nextCursor);
        void api.conversations.read(id);
        setUnread({ messages: Math.max(0, unread.messages - (conv?.unreadCount ?? 0)) });
      },
      (e) => toast(errorMessage(e)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages?.length]);

  useRealtime((e) => {
    if (e.type === 'message.created' && e.data.conversationId === id) {
      setMessages((cur) => {
        if (!cur) return cur;
        const m = e.data as Message;
        if (cur.some((x) => x.id === m.id)) return cur;
        const pendingIdx = m.clientId ? cur.findIndex((x) => x.clientId === m.clientId) : -1;
        if (pendingIdx >= 0) return cur.map((x, i) => (i === pendingIdx ? m : x));
        return [...cur, m];
      });
      if (e.data.sender.id !== me?.id) void api.conversations.read(id);
    }
    if (e.type === 'message.deleted' && e.data.conversationId === id) setMessages((cur) => cur?.filter((x) => x.id !== e.data.id) ?? cur);
    // A message held for a check was let through: load it (or clear the "waiting" label on your own).
    if (e.type === 'message.released' && e.data.conversationId === id)
      api.conversations.messages(id).then(
        (r) => setMessages(r.items),
        () => {},
      );
    if (e.type === 'typing' && e.data.conversationId === id) {
      const who = conv?.members.find((m) => m.id === e.data.userId)?.displayName ?? 'Someone';
      setTyping(who);
      setTimeout(() => setTyping(null), 3000);
    }
  });

  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);

  /** Upload a photo, video or voice recording, then send it as a message. */
  async function sendFile(file: File, label: string) {
    if (!me) return;
    if (file.size > 50 * 1024 * 1024) return toast('Files in chats can be up to 50 MB.');
    setUploading(label);
    try {
      const { media } = await api.media.upload(file);
      const clientId = crypto.randomUUID();
      const { message, notice } = await api.conversations.send(id, '', clientId, [{ mediaId: media.id }]);
      setMessages((cur) => (cur?.some((x) => x.id === message.id) ? cur : [...(cur ?? []), message]));
      if (notice) toast(notice);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setUploading(null);
    }
  }

  async function send() {
    const text = body.trim();
    if (!text || !me) return;
    const clientId = crypto.randomUUID();
    const optimistic: Pending = {
      id: clientId,
      conversationId: id,
      sender: { id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl, mode: me.mode },
      body: text,
      replyToId: null,
      attachments: [],
      createdAt: new Date().toISOString(),
      clientId,
      pending: true,
    };
    setMessages((cur) => [...(cur ?? []), optimistic]);
    setBody('');
    try {
      const { message, notice } = await api.conversations.send(id, text, clientId);
      setMessages((cur) => cur?.map((x) => (x.clientId === clientId ? message : x)) ?? cur);
      if (notice) toast(notice);
    } catch (e) {
      setMessages((cur) => cur?.filter((x) => x.clientId !== clientId) ?? cur);
      setBody(text);
      toast(errorMessage(e));
    }
  }

  async function assist(task: 'summarize_conversation' | 'plan_from_message') {
    setAiLoading(true);
    try {
      if (task === 'summarize_conversation') {
        const r = await api.ai.assist({ task, conversationId: id });
        setAi({ title: 'Summary', text: String(r.output ?? ''), notice: r.notice });
      } else {
        const last = [...(messages ?? [])].reverse().find((m) => m.body)?.body ?? '';
        const r = await api.ai.assist({ task, input: last });
        const plan = r.output as Record<string, unknown>;
        setAi({
          title: 'Plan draft',
          text:
            Object.entries(plan)
              .filter(([, v]) => v && (!Array.isArray(v) || v.length))
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
              .join('\n') || 'Not enough detail to draft a plan yet.',
          notice: r.notice,
          plan,
        });
      }
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setAiLoading(false);
    }
  }

  const others = conv?.members.filter((m) => m.id !== me?.id) ?? [];
  const title = conv ? conv.title || others.map((m) => m.displayName).join(', ') : '';
  let lastDay = '';

  return (
    <div className="yp-shell__inner chat-page">
      <div className="yp-topbar">
        <div className="row" style={{ minWidth: 0 }}>
          <Link href="/inbox" className="yp-action" aria-label="Back to inbox">
            <Icon name="arrow-left" />
          </Link>
          <h1 style={{ fontSize: 20, lineHeight: '26px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title || <Skeleton width={160} />}
          </h1>
        </div>
        <Menu
          label="Conversation options"
          actions={[
            { label: 'Video call', icon: 'eye', onSelect: () => void calls.start(id, 'video') },
            { label: 'Apps', icon: 'create', onSelect: () => setAppsOpen(true) },
            { label: 'Audio call', icon: 'bell', onSelect: () => void calls.start(id, 'audio') },
            { label: t('inbox.summarize'), icon: 'sparkle', onSelect: () => assist('summarize_conversation') },
            { label: 'Draft a plan from the last message', icon: 'calendar', onSelect: () => assist('plan_from_message') },
            ...(others.length === 1
              ? [{ label: `View ${others[0]!.displayName}'s profile`, icon: 'user' as const, onSelect: () => (location.href = `/u/${others[0]!.username}`) }]
              : []),
          ]}
        />
      </div>

      {ai || aiLoading ? (
        <AIPanel
          title={ai?.title ?? 'Working…'}
          loading={aiLoading}
          notice={ai?.notice}
          actions={
            ai ? (
              <>
                {ai.plan ? (
                  <Button
                    size="sm"
                    onClick={async () => {
                      await api.conversations.createPlan(id, String(ai.plan!.destination ?? 'New plan'), ai.plan!);
                      toast('Plan saved to this conversation');
                      setAi(null);
                    }}
                  >
                    Save plan
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => setAi(null)}>
                  Close
                </Button>
              </>
            ) : null
          }
        >
          {ai?.text}
        </AIPanel>
      ) : null}

      {messages === null ? (
        <Skeleton height={300} />
      ) : (
        <div className="yp-chat" role="log" aria-live="polite" aria-relevant="additions" aria-label="Messages">
          {cursor ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const r = await api.conversations.messages(id, cursor);
                setMessages((cur) => [...r.items, ...(cur ?? [])]);
                setCursor(r.nextCursor);
              }}
            >
              Load earlier messages
            </Button>
          ) : null}
          {messages.map((m) => {
            const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(m.createdAt));
            const showDay = day !== lastDay;
            lastDay = day;
            const mine = m.sender.id === me?.id;
            return (
              <div key={m.id} style={{ display: 'contents' }}>
                {showDay ? <div className="yp-chat__day">{day}</div> : null}
                <div
                  style={{ display: 'flex', flexDirection: 'column' }}
                  onContextMenu={(e) => {
                    if (mine) return;
                    e.preventDefault();
                    setReportId(m.id);
                  }}
                >
                  <ChatBubble
                    mine={mine}
                    sender={others.length > 1 ? m.sender.displayName : undefined}
                    body={
                      m.attachments.length ? (
                        <>
                          <MessageAttachments items={m.attachments} />
                          {m.body ? <div>{m.body}</div> : null}
                        </>
                      ) : (
                        m.body
                      )
                    }
                    pending={m.pending}
                    time={new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(m.createdAt))}
                  />
                  {m.moderation === 'review' ? <span className="chat-held">Waiting for a quick check before it’s delivered</span> : null}
                </div>
              </div>
            );
          })}
          {typing ? (
            <span className="muted" style={{ fontSize: 12 }}>
              {typing} is typing…
            </span>
          ) : null}
          <div ref={endRef} />
        </div>
      )}

      <form
        className="yp-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm"
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void sendFile(f, f.type.startsWith('video') ? 'Sending video…' : 'Sending photo…');
          }}
        />
        <button type="button" className="yp-action" aria-label="Send a photo or video" disabled={!!uploading} onClick={() => fileInput.current?.click()}>
          <Icon name="image" />
        </button>
        <VoiceRecorder disabled={!!uploading} onError={toast} onRecorded={(f) => void sendFile(f, 'Sending voice message…')} />
        {uploading ? (
          <span className="muted" role="status" style={{ fontSize: 13 }}>
            {uploading}
          </span>
        ) : null}
        <label htmlFor="msg" className="yp-visually-hidden">
          {t('inbox.placeholder')}
        </label>
        <textarea
          id="msg"
          rows={1}
          placeholder={t('inbox.placeholder')}
          value={body}
          maxLength={4000}
          onChange={(e) => setBody(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button type="submit" icon="send" disabled={!body.trim()} aria-label={t('inbox.send')}>
          {t('inbox.send')}
        </Button>
      </form>
      <ReportSheet target={reportId ? { type: 'message', id: reportId } : null} onClose={() => setReportId(null)} />
      <MiniAppsSheet
        open={appsOpen}
        onClose={() => setAppsOpen(false)}
        surface="conversation"
        surfaceId={id}
        onSend={async (text) => {
          await api.conversations.send(id, text, crypto.randomUUID());
        }}
      />
    </div>
  );
}
