'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AIPanel, Button, Icon } from '@yapilapi/design-system';
import type { AgentKind, AgentResult } from '@yapilapi/api-client';
import { agentActionLabel, agentSubtitle, type MessageKey } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const TYPE_LABEL: Record<string, MessageKey> = {
  event: 'm.type.event',
  place: 'm.type.place',
  community: 'm.type.community',
  person: 'm.type.person',
  product: 'm.type.product',
  business: 'm.type.business',
};

/** Catalog keys for each assistant; translate them with t() where they show. */
export const AGENTS: Record<AgentKind, { title: MessageKey; placeholder: MessageKey; examples: MessageKey[] }> = {
  discover: {
    title: 'm.assistant.kind.discover',
    placeholder: 'm.assistant.placeholder.discover',
    examples: ['agent.example.discover.tonight', 'agent.example.discover.photography', 'agent.example.discover.music'],
  },
  travel: {
    title: 'm.assistant.kind.travel',
    placeholder: 'm.assistant.placeholder.travel',
    examples: ['agent.example.travel.lisbon', 'agent.example.travel.accra'],
  },
  shopping: {
    title: 'm.assistant.kind.shopping',
    placeholder: 'm.assistant.placeholder.shopping',
    examples: ['agent.example.shopping.gift', 'agent.example.shopping.tickets'],
  },
  business: {
    title: 'm.assistant.kind.business',
    placeholder: 'm.assistant.placeholder.business',
    examples: ['agent.example.business.month', 'agent.example.business.reviews'],
  },
};

/**
 * Ask an assistant. Results are cards for things that exist on YAPILAPI, each
 * with the reason it was picked; suggested actions only happen when you tap them.
 */
export function AgentPanel({ kind, businessId, compact = false }: { kind: AgentKind; businessId?: string; compact?: boolean }) {
  const { toast, locale, t, tp } = useSession();
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const agent = AGENTS[kind];
  const a = { title: t(agent.title), placeholder: t(agent.placeholder), examples: agent.examples.map((k) => t(k)) };

  async function ask(text: string) {
    if (!text.trim()) return;
    setPrompt(text);
    setBusy(true);
    setError(null);
    try {
      setRes(await api.agents.run(kind, text.trim(), businessId));
    } catch (e) {
      setRes(null);
      setError(kind === 'business' && e instanceof ApiError && e.status === 404 ? t('agent.businessOnly') : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(action: AgentResult['actions'][number]) {
    const target = action.target;
    try {
      if (action.kind === 'rsvp') await api.events.rsvp(target.id, 'going');
      else if (action.kind === 'follow') await api.users.follow(target.id);
      else if (action.kind === 'join') await api.communities.join(target.href.replace('/c/', ''));
      else {
        // Bookings need a time and party size, purchases need checkout: open the item to finish there.
        router.push(target.href);
        return;
      }
      setDone((d) => new Set(d).add(target.id));
      toast(
        action.kind === 'rsvp'
          ? t('agent.going', { title: target.title })
          : action.kind === 'follow'
            ? t('follow.followingName', { name: target.title })
            : t('agent.joined', { title: target.title }),
      );
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <section className={compact ? 'agent agent--compact' : 'agent'} aria-label={t('agent.panelLabel', { name: a.title })}>
      <form
        className="agent__ask"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(prompt);
        }}
      >
        <Icon name="sparkle" size={20} />
        <label htmlFor={`agent-${kind}`} className="yp-visually-hidden">
          {a.placeholder}
        </label>
        <input id={`agent-${kind}`} value={prompt} onChange={(e) => setPrompt(e.currentTarget.value)} placeholder={a.placeholder} maxLength={1000} />
        <Button type="submit" size="sm" loading={busy} disabled={!prompt.trim()}>
          {t('m.assistant.ask')}
        </Button>
      </form>
      {!res && !busy && !error ? (
        <div className="row">
          {a.examples.map((x) => (
            <button key={x} type="button" className="yp-chip" onClick={() => ask(x)}>
              {x}
            </button>
          ))}
        </div>
      ) : null}
      {error ? <p className="yp-field__error">{error}</p> : null}
      {res ? (
        <AIPanel title={t('agent.panelLabel', { name: a.title })} notice={res.notice ?? t('m.assistant.answeredBy', { model: res.model })}>
          <div className="stack">
            {res.text ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{res.text}</p> : null}
            {res.recommendations.length ? (
              <ul className="agent__cards">
                {res.recommendations.map((r) => (
                  <li key={`${r.type}:${r.id}`}>
                    <Link href={r.href} className="agent__card">
                      <span className="agent__type">{TYPE_LABEL[r.type] ? t(TYPE_LABEL[r.type]) : r.type}</span>
                      <strong>{r.title}</strong>
                      {r.startsAt || agentSubtitle(r, tp) ? (
                        <span className="muted">
                          {[
                            r.startsAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(r.startsAt)) : null,
                            agentSubtitle(r, tp),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      ) : null}
                      <span className="agent__why">{r.reason}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
            {res.actions.length ? (
              <div className="row">
                {res.actions.map((x) => (
                  <Button
                    key={x.target.id}
                    size="sm"
                    variant={done.has(x.target.id) ? 'secondary' : 'primary'}
                    disabled={done.has(x.target.id)}
                    onClick={() => act(x)}
                  >
                    {done.has(x.target.id) ? t('m.common.done') : agentActionLabel(x, t)}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </AIPanel>
      ) : null}
    </section>
  );
}
