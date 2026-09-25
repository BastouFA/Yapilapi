'use client';

import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, ChatBubble, EmptyState, Menu, Segments, Skeleton } from '@yapilapi/design-system';
import type { LiveChatMessage, LiveSummary } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useRealtime, useSession } from '../../../providers';
import { HlsVideo } from '@/components/HlsVideo';
import { TipSheet } from '@/components/SupportCreator';
import { formatMoney } from '@yapilapi/shared';

export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  const { me, toast, locale, flags } = useSession();
  const [live, setLive] = useState<LiveSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const [chat, setChat] = useState<LiveChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'chat' | 'question'>('chat');
  const [gifting, setGifting] = useState(false);
  const [ingest, setIngest] = useState<{ url: string; streamKey: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const isHost = live?.myRole === 'host';
  const canModerate = live?.myRole === 'host' || live?.myRole === 'cohost' || live?.myRole === 'moderator';

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`ypl-ingest-${id}`);
      if (raw) setIngest(JSON.parse(raw));
    } catch {
      /* storage may be unavailable */
    }
    api.live.get(id).then(
      async (r) => {
        setLive(r.live);
        if (r.live.status === 'live' && !r.live.myRole) setLive((await api.live.join(id).catch(() => r)).live);
        api.live
          .chat(id)
          .then((c) => setChat(c.items))
          .catch(() => {});
      },
      () => setMissing(true),
    );
    return () => void api.live.leave(id).catch(() => {});
  }, [id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.length]);

  useRealtime((e) => {
    if (e.type === 'live.chat' && e.data.liveId === id) setChat((c) => (c.some((m) => m.id === e.data.message.id) ? c : [...c, e.data.message]));
    if (e.type === 'live.chat_deleted' && e.data.liveId === id) setChat((c) => c.filter((m) => m.id !== e.data.messageId));
    if (e.type === 'live.viewers' && e.data.id === id) setLive((l) => (l ? { ...l, viewers: e.data.viewers } : l));
    if (e.type === 'live.status' && e.data.id === id) {
      if (e.data.status === 'removed') toast('You were removed from this live.');
      setLive((l) => (l ? { ...l, status: 'ended' } : l));
    }
  });

  if (missing) return <EmptyState title="This live isn't available" />;
  if (!live) return <Skeleton height={320} />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1 style={{ fontSize: 22 }}>{live.title}</h1>
        {live.status === 'live' ? (
          <Badge tone="danger">Live · {live.viewers} watching</Badge>
        ) : (
          <Badge tone="neutral">{live.status === 'ended' ? 'Ended' : 'Scheduled'}</Badge>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        Hosted by {live.host.displayName}
      </p>

      <div
        style={{
          aspectRatio: '16 / 9',
          maxWidth: '100%',
          background: '#0b100e',
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          color: '#c7d2cd',
          overflow: 'hidden',
        }}
      >
        {live.status === 'live' && live.playbackUrl ? (
          <HlsVideo src={live.playbackUrl} live label="Live video" />
        ) : (
          <span>{live.status === 'ended' ? 'This live has ended.' : 'Waiting for the host to go live.'}</span>
        )}
      </div>

      {isHost ? (
        <div className="stack-sm">
          {ingest && live.status !== 'ended' ? (
            <Alert tone="info" title="Streaming software settings">
              Server: <code>{ingest.url}</code>
              <br />
              Stream key: <code style={{ wordBreak: 'break-all' }}>{ingest.streamKey}</code>
              <br />
              Keep the key private. Video delivery needs a live-video provider in production.
            </Alert>
          ) : null}
          <div className="row">
            {live.status === 'scheduled' ? (
              <Button onClick={async () => setLive((await api.live.start(id)).live)} icon="send">
                Go live
              </Button>
            ) : null}
            {live.status === 'live' ? (
              <Button variant="danger" onClick={async () => setLive((await api.live.end(id)).live)}>
                End live
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="stack-sm" aria-label="Live chat">
        <h2 className="section-title">Chat</h2>
        <div className="yp-chat" aria-live="polite" style={{ maxHeight: 360, overflowY: 'auto' }}>
          {chat.map((m) =>
            m.kind === 'gift' ? (
              <div key={m.id} className="live-gift" role="status">
                <span className="live-gift__amount">{formatMoney(m.amountCents ?? 0, m.currency ?? 'USD', locale)}</span>
                <span>
                  <strong>{m.author.displayName}</strong> sent a gift{m.body ? `: ${m.body}` : ''}
                </span>
              </div>
            ) : (
              <div key={m.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ChatBubble mine={m.author.id === me?.id} sender={m.author.displayName} body={m.kind === 'question' ? `Question: ${m.body}` : m.body} />
                </div>
                {canModerate && m.author.id !== me?.id ? (
                  <Menu
                    label="Moderate"
                    actions={[
                      {
                        label: 'Remove message',
                        icon: 'trash',
                        onSelect: () => api.raw.del(`/v1/live/${id}/chat/${m.id}`).catch((e) => toast(errorMessage(e))),
                      },
                      {
                        label: `Remove ${m.author.displayName}`,
                        icon: 'shield',
                        danger: true,
                        onSelect: () => api.live.ban(id, m.author.id).then(() => toast('Removed from the live')),
                      },
                    ]}
                  />
                ) : null}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
        {live.status === 'live' ? (
          <form
            className="yp-composer"
            style={{ position: 'static' }}
            onSubmit={async (e) => {
              e.preventDefault();
              if (!body.trim()) return;
              try {
                await api.live.send(id, body.trim(), kind);
                setBody('');
              } catch (err) {
                toast(errorMessage(err));
              }
            }}
          >
            <Segments
              label="Message type"
              value={kind}
              onChange={setKind}
              options={[
                { id: 'chat', label: 'Chat' },
                { id: 'question', label: 'Question' },
              ]}
            />
            <label htmlFor="live-msg" className="yp-visually-hidden">
              Message
            </label>
            <textarea
              id="live-msg"
              rows={1}
              value={body}
              maxLength={500}
              onChange={(e) => setBody(e.currentTarget.value)}
              placeholder={kind === 'question' ? 'Ask the host a question' : 'Say something'}
            />
            <Button type="submit" disabled={!body.trim()}>
              Send
            </Button>
          </form>
        ) : null}
        {live.status === 'live' && !isHost && flags.COMMERCE !== false ? (
          <>
            <Button variant="secondary" icon="sparkle" onClick={() => setGifting(true)}>
              Send a gift
            </Button>
            <TipSheet open={gifting} onClose={() => setGifting(false)} userId={live.host.id} name={live.host.displayName} liveId={live.id} />
          </>
        ) : null}
      </section>
    </div>
  );
}
