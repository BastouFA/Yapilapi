'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AIPanel, Button, Icon } from '@yapilapi/design-system';
import type { AgentKind, AgentResult } from '@yapilapi/api-client';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

const TYPE_LABEL: Record<string, string> = {
  event: 'Event',
  place: 'Place',
  community: 'Community',
  person: 'Person',
  product: 'Product',
  business: 'Business',
};

export const AGENTS: Record<AgentKind, { title: string; placeholder: string; examples: string[] }> = {
  discover: {
    title: 'Discover',
    placeholder: 'What are you in the mood for?',
    examples: ['Something to do tonight', 'Photography groups near me', 'Live music this weekend'],
  },
  travel: {
    title: 'Trips',
    placeholder: 'Where are you going, and when?',
    examples: ['Two days in Lisbon next weekend', 'A food day in Accra on Saturday'],
  },
  shopping: {
    title: 'Shopping',
    placeholder: 'What do you need?',
    examples: ['A handmade gift under $40', 'Tickets for a concert this month'],
  },
  business: {
    title: 'Business',
    placeholder: 'Ask about your bookings, reviews or sales',
    examples: ['How did we do this month?', 'Draft replies to our latest reviews'],
  },
};

/**
 * Ask an assistant. Results are cards for things that exist on YAPILAPI, each
 * with the reason it was picked; suggested actions only happen when you tap them.
 */
export function AgentPanel({ kind, businessId, compact = false }: { kind: AgentKind; businessId?: string; compact?: boolean }) {
  const { toast, locale } = useSession();
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const a = AGENTS[kind];

  async function ask(text: string) {
    if (!text.trim()) return;
    setPrompt(text);
    setBusy(true);
    setError(null);
    try {
      setRes(await api.agents.run(kind, text.trim(), businessId));
    } catch (e) {
      setRes(null);
      setError(
        kind === 'business' && e instanceof ApiError && e.status === 404
          ? 'The business assistant works for business owners. Create a business profile first.'
          : errorMessage(e),
      );
    } finally {
      setBusy(false);
    }
  }

  async function act(action: AgentResult['actions'][number]) {
    const t = action.target;
    try {
      if (action.kind === 'rsvp') await api.events.rsvp(t.id, 'going');
      else if (action.kind === 'follow') await api.users.follow(t.id);
      else if (action.kind === 'join') await api.communities.join(t.href.replace('/c/', ''));
      else {
        // Bookings need a time and party size, purchases need checkout: open the item to finish there.
        router.push(t.href);
        return;
      }
      setDone((d) => new Set(d).add(t.id));
      toast(action.kind === 'rsvp' ? `You're going to ${t.title}` : action.kind === 'follow' ? `Following ${t.title}` : `Joined ${t.title}`);
    } catch (e) {
      toast(errorMessage(e));
    }
  }

  return (
    <section className={compact ? 'agent agent--compact' : 'agent'} aria-label={`${a.title} assistant`}>
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
          Ask
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
        <AIPanel title={`${a.title} assistant`} notice={res.notice ?? `Answered by ${res.model}. It only used what you can see on YAPILAPI.`}>
          <div className="stack">
            {res.text ? <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{res.text}</p> : null}
            {res.recommendations.length ? (
              <ul className="agent__cards">
                {res.recommendations.map((r) => (
                  <li key={`${r.type}:${r.id}`}>
                    <Link href={r.href} className="agent__card">
                      <span className="agent__type">{TYPE_LABEL[r.type]}</span>
                      <strong>{r.title}</strong>
                      {r.startsAt || r.subtitle ? (
                        <span className="muted">
                          {[
                            r.startsAt ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(r.startsAt)) : null,
                            r.subtitle,
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
                    {done.has(x.target.id) ? 'Done' : x.label}
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
