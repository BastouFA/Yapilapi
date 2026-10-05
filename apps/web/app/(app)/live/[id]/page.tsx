'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, ChatBubble, EmptyState, Menu, Segments, Skeleton } from '@yapilapi/design-system';
import type { LiveChatMessage, LiveSummary } from '@yapilapi/api-client';
import { api, errorMessage, isGone } from '@/lib/api';
import { useRealtime, useSession } from '../../../providers';
import { HlsVideo } from '@/components/HlsVideo';
import { TipSheet } from '@/components/SupportCreator';
import { LiveShop } from '@/components/LiveShop';
import { useCheckout } from '@/components/Checkout';
import { LiveClips } from '@/components/LiveClips';
import { formatMoney } from '@yapilapi/shared';

/** A translated sentence with an element (a name, a code sample) in place of one placeholder. */
function around(template: string, placeholder: string, node: ReactNode) {
  const [before = '', after = ''] = template.split(placeholder);
  return (
    <>
      {before}
      {node}
      {after}
    </>
  );
}

export default function LivePage() {
  const { id } = useParams<{ id: string }>();
  const { me, toast, locale, flags, t, tp } = useSession();
  const [live, setLive] = useState<LiveSummary | null>(null);
  const [waitingForTicket, setWaitingForTicket] = useState(false);
  const checkout = useCheckout();
  // After buying a ticket, check until the payment is confirmed, then join and start playback.
  useEffect(() => {
    if (!waitingForTicket) return;
    const timer = setInterval(async () => {
      const r = await api.live.get(id).catch(() => null);
      if (!r?.live.ticket?.hasTicket) return;
      setWaitingForTicket(false);
      setLive(r.live.status === 'live' ? (await api.live.join(id).catch(() => r)).live : r.live);
      setChat((await api.live.chat(id).catch(() => ({ items: [] }))).items);
    }, 3000);
    return () => clearInterval(timer);
  }, [waitingForTicket, id]);
  const [missing, setMissing] = useState(false);
  // Why it couldn't load, when that isn't because it's gone or private.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chat, setChat] = useState<LiveChatMessage[]>([]);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<'chat' | 'question'>('chat');
  const [gifting, setGifting] = useState(false);
  const [translated, setTranslated] = useState<Record<string, string>>({});
  async function translate(id: string, text: string) {
    try {
      const r = await api.ai.assist({ task: 'translate', input: text, targetLanguage: locale });
      const out = (r.output as { translated?: string | null } | null)?.translated;
      if (out) setTranslated((cur) => ({ ...cur, [id]: out }));
      else toast(r.notice ?? (r.output as { notice?: string } | null)?.notice ?? t('live.translateFailed'));
    } catch (e) {
      toast(errorMessage(e));
    }
  }
  const [ingest, setIngest] = useState<{ url: string; streamKey: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const isHost = live?.myRole === 'host';
  const canModerate = live?.myRole === 'host' || live?.myRole === 'cohost' || live?.myRole === 'moderator';

  const load = useCallback(() => {
    setLoadError(null);
    api.live.get(id).then(
      async (r) => {
        setLive(r.live);
        if (r.live.status === 'live' && !r.live.myRole) setLive((await api.live.join(id).catch(() => r)).live);
        api.live
          .chat(id)
          .then((c) => setChat(c.items))
          .catch(() => {});
      },
      (e) => (isGone(e) ? setMissing(true) : setLoadError(errorMessage(e))),
    );
  }, [id]);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(`ypl-ingest-${id}`);
      if (raw) setIngest(JSON.parse(raw));
    } catch {
      /* storage may be unavailable */
    }
    load();
    // Closing the tab counts too, so the number watching stays right.
    const bye = () => navigator.sendBeacon?.(`/api/v1/live/${id}/leave`);
    window.addEventListener('pagehide', bye);
    return () => {
      window.removeEventListener('pagehide', bye);
      void api.live.leave(id).catch(() => {});
    };
  }, [id, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.length]);

  // Waiting for a scheduled live: look again now and then, and join when it starts.
  const waitingToStart = live?.status === 'scheduled' && live.myRole !== 'host';
  useEffect(() => {
    if (!waitingToStart) return;
    const timer = setInterval(async () => {
      const r = await api.live.get(id).catch(() => null);
      if (r?.live.status === 'live') load();
    }, 10_000);
    return () => clearInterval(timer);
  }, [waitingToStart, id, load]);

  /** Start or end the live; what went wrong is said. */
  const hostAction = async (run: () => Promise<{ live: LiveSummary }>) => {
    try {
      setLive((await run()).live);
    } catch (e) {
      toast(errorMessage(e));
    }
  };

  useRealtime((e) => {
    if (e.type === 'live.chat' && e.data.liveId === id) setChat((c) => (c.some((m) => m.id === e.data.message.id) ? c : [...c, e.data.message]));
    if (e.type === 'live.chat_deleted' && e.data.liveId === id) setChat((c) => c.filter((m) => m.id !== e.data.messageId));
    if (e.type === 'live.viewers' && e.data.id === id) setLive((l) => (l ? { ...l, viewers: e.data.viewers } : l));
    if (e.type === 'live.status' && e.data.id === id) {
      if (e.data.status === 'removed') toast(t('m.live.removedYou'));
      setLive((l) => (l ? { ...l, status: 'ended' } : l));
    }
  });

  if (missing) return <EmptyState level={1} title={t('m.live.missing')} />;
  if (!live && loadError) return <EmptyState level={1} title={loadError} action={<Button onClick={load}>{t('m.common.retry')}</Button>} />;
  if (!live) return <Skeleton height={320} />;

  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1 style={{ fontSize: 22 }}>{live.title}</h1>
        {live.status === 'live' ? (
          <Badge tone="danger">{tp('live.badgeWatching', live.viewers)}</Badge>
        ) : (
          <Badge tone="neutral">{live.status === 'ended' ? t('m.live.ended') : t('m.live.scheduled')}</Badge>
        )}
      </div>
      <p className="muted" style={{ margin: 0 }}>
        {t('m.live.hostedBy', { name: live.host.displayName })}
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
          <HlsVideo src={live.playbackUrl} live label={t('live.video')} />
        ) : (
          <span>{live.status === 'ended' ? t('m.live.endedBody') : t('m.live.waiting')}</span>
        )}
      </div>

      {live.ticket && !live.ticket.hasTicket ? (
        <Alert tone="warning" title={`${live.ticket.title}: ${formatMoney(live.ticket.priceCents, live.ticket.currency, locale)}`}>
          <p style={{ margin: '0 0 8px' }}>{waitingForTicket ? t('live.ticket.waiting') : t('live.ticket.body')}</p>
          <Button
            size="sm"
            loading={waitingForTicket}
            onClick={async () => {
              try {
                const r = await api.orders.create([{ productId: live.ticket!.productId, quantity: 1 }], crypto.randomUUID(), live.id);
                if (r.order.status !== 'paid' && r.payment)
                  checkout({
                    orderId: r.order.id,
                    clientSecret: r.payment.clientSecret,
                    provider: r.payment.provider,
                    label: `${live.ticket!.title}, ${formatMoney(live.ticket!.priceCents, live.ticket!.currency, locale)}`,
                  });
                setWaitingForTicket(true);
              } catch (e) {
                toast(errorMessage(e));
              }
            }}
          >
            {t('live.ticket.buy')}
          </Button>
        </Alert>
      ) : null}

      {isHost && live.status === 'ended' ? <LiveClips liveId={live.id} /> : null}
      <LiveShop liveId={live.id} isHost={isHost} hostId={live.host.id} />

      {isHost ? (
        <div className="stack-sm">
          {ingest && live.status !== 'ended' ? (
            <Alert tone="info" title={t('live.ingest.title')}>
              {around(t('live.ingest.server'), '{url}', <code>{ingest.url}</code>)}
              <br />
              {around(t('live.ingest.key'), '{key}', <code style={{ wordBreak: 'break-all' }}>{ingest.streamKey}</code>)}
              <br />
              {t('live.ingest.note')}
            </Alert>
          ) : live.status !== 'ended' ? (
            // The key is shown once: a page opened later can get a new one.
            <div className="stack-sm">
              <p className="muted" style={{ margin: 0 }}>
                {t('live.newKeyHint')}
              </p>
              <div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon="key"
                  onClick={async () => {
                    try {
                      const r = await api.live.newKey(id);
                      setIngest(r.ingest);
                      try {
                        sessionStorage.setItem(`ypl-ingest-${id}`, JSON.stringify(r.ingest));
                      } catch {
                        /* storage may be unavailable */
                      }
                    } catch (e) {
                      toast(errorMessage(e));
                    }
                  }}
                >
                  {t('live.newKey')}
                </Button>
              </div>
            </div>
          ) : null}
          <div className="row">
            {live.status === 'scheduled' ? (
              <Button onClick={() => void hostAction(() => api.live.start(id))} icon="send">
                {t('live.start')}
              </Button>
            ) : null}
            {live.status === 'live' ? (
              <Button variant="danger" onClick={() => void hostAction(() => api.live.end(id))}>
                {t('m.live.end')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="stack-sm" aria-label={t('live.chat')}>
        <h2 className="section-title">{t('m.live.chat')}</h2>
        <div className="yp-chat" aria-live="polite" style={{ maxHeight: 360, overflowY: 'auto' }}>
          {chat.map((m) =>
            m.kind === 'gift' ? (
              <div key={m.id} className="live-gift" role="status">
                <span className="live-gift__amount">{formatMoney(m.amountCents ?? 0, m.currency ?? 'USD', locale)}</span>
                <span>{around(m.body ? t('live.giftWithNote', { note: m.body }) : t('live.gift'), '{name}', <strong>{m.author.displayName}</strong>)}</span>
              </div>
            ) : (
              <div key={m.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <ChatBubble
                    mine={m.author.id === me?.id}
                    sender={m.author.displayName}
                    body={m.kind === 'question' ? t('live.questionBody', { text: translated[m.id] ?? m.body }) : (translated[m.id] ?? m.body)}
                  />
                  {flags.AI_TRANSLATION && m.author.id !== me?.id && !translated[m.id] ? (
                    <button type="button" className="live-translate" onClick={() => translate(m.id, m.body)}>
                      {t('live.translate')}
                    </button>
                  ) : null}
                </div>
                {canModerate && m.author.id !== me?.id ? (
                  <Menu
                    label={t('live.moderate')}
                    actions={[
                      {
                        label: t('m.live.removeMessage'),
                        icon: 'trash',
                        onSelect: () => api.raw.del(`/v1/live/${id}/chat/${m.id}`).catch((e) => toast(errorMessage(e))),
                      },
                      {
                        label: t('live.removePerson', { name: m.author.displayName }),
                        icon: 'shield',
                        danger: true,
                        onSelect: () => api.live.ban(id, m.author.id).then(() => toast(t('m.live.removed'))),
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
              label={t('live.messageType')}
              value={kind}
              onChange={setKind}
              options={[
                { id: 'chat', label: t('m.live.chat') },
                { id: 'question', label: t('m.live.question') },
              ]}
            />
            <label htmlFor="live-msg" className="yp-visually-hidden">
              {t('m.live.message')}
            </label>
            <textarea
              id="live-msg"
              rows={1}
              value={body}
              maxLength={500}
              onChange={(e) => setBody(e.currentTarget.value)}
              placeholder={kind === 'question' ? t('m.live.ask') : t('m.live.say')}
            />
            <Button type="submit" disabled={!body.trim()}>
              {t('m.live.send')}
            </Button>
          </form>
        ) : null}
        {live.status === 'live' && !isHost && flags.COMMERCE !== false ? (
          <>
            <Button variant="secondary" icon="sparkle" onClick={() => setGifting(true)}>
              {t('live.sendGift')}
            </Button>
            <TipSheet open={gifting} onClose={() => setGifting(false)} userId={live.host.id} name={live.host.displayName} liveId={live.id} />
          </>
        ) : null}
      </section>
    </div>
  );
}
