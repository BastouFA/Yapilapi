'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@yapilapi/design-system';
import { useSession } from '@/app/providers';
import { api } from '@/lib/api';

export type GifResult = Awaited<ReturnType<typeof api.gifs.list>>['items'][number];
type Page = Awaited<ReturnType<typeof api.gifs.list>>;

// Whether there are GIFs at all (the server has a GIPHY or KLIPY key), asked once per page load with the
// trending ones, which the panel then shows without asking again.
let first: Promise<Page | null> | null = null;
let enabled: boolean | null = null;
const listeners = new Set<() => void>();
function trending(): Promise<Page | null> {
  first ??= api.gifs.list().then(
    (r) => {
      enabled = r.enabled;
      listeners.forEach((l) => l());
      return r;
    },
    () => {
      first = null;
      return null;
    },
  );
  return first;
}

/** True once the server says GIFs are on; asks the first time it's used. */
export function useGifsEnabled(): boolean {
  useEffect(() => void trending(), []);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => enabled === true,
    () => false,
  );
}

/**
 * The GIF tab beside the emojis: trending GIFs from GIPHY or KLIPY, or a search. Tapping one sends
 * it (onPick). The search box and the credit name the one the results come from, as each asks.
 */
export function GifPicker({ onPick }: { onPick: (gif: GifResult) => void }) {
  const { t } = useSession();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<GifResult[] | null>(null);
  const [provider, setProvider] = useState<Page['provider']>();
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const asked = useRef(0);

  useEffect(() => {
    const n = ++asked.current;
    setFailed(false);
    const q = query.trim();
    const timer = setTimeout(
      () => {
        (q ? api.gifs.list(q) : trending().then((r) => r ?? api.gifs.list())).then(
          (r) => {
            if (n !== asked.current) return;
            setItems(r.items);
            setNext(r.next);
            setProvider(r.provider);
          },
          () => n === asked.current && setFailed(true),
        );
      },
      q ? 350 : 0,
    );
    return () => clearTimeout(timer);
  }, [query, attempt]);

  function more() {
    if (next === null || loadingMore) return;
    const n = asked.current;
    setLoadingMore(true);
    api.gifs
      .list(query.trim() || undefined, next)
      .then(
        (r) => {
          if (n !== asked.current) return;
          setItems((cur) => [...(cur ?? []), ...r.items.filter((g) => !cur?.some((x) => x.id === g.id))]);
          setNext(r.next);
        },
        () => {},
      )
      .finally(() => setLoadingMore(false));
  }

  const giphy = provider === 'giphy';
  const searchLabel = t(giphy ? 'gif.searchGiphy' : 'gif.search');
  return (
    <div className="gif-panel">
      <input
        className="yp-input gif-panel__search"
        type="search"
        value={query}
        placeholder={searchLabel}
        aria-label={searchLabel}
        enterKeyHint="search"
        onChange={(e) => setQuery(e.currentTarget.value)}
      />
      <div
        className="gif-panel__body"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight > el.scrollHeight - 200) more();
        }}
      >
        {failed ? (
          <p className="gif-panel__note" role="status">
            {t('gif.error')}{' '}
            <Button size="sm" variant="ghost" onClick={() => setAttempt((a) => a + 1)}>
              {t('m.common.retry')}
            </Button>
          </p>
        ) : items && !items.length ? (
          <p className="gif-panel__note" role="status">
            {t('gif.none')}
          </p>
        ) : (
          <div className="gif-panel__grid">
            {(items ?? []).map((g) => (
              <button
                key={g.id}
                type="button"
                className="gif-panel__gif"
                aria-label={t('gif.send', { title: g.title || 'GIF' })}
                style={{ aspectRatio: `${g.preview.width} / ${g.preview.height}` }}
                onClick={() => onPick(g)}
              >
                <img src={g.preview.url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" />
              </button>
            ))}
          </div>
        )}
        {next !== null && items?.length && !failed ? (
          <Button size="sm" variant="ghost" className="gif-panel__more" onClick={more} disabled={loadingMore}>
            {t('feed.loadMore')}
          </Button>
        ) : null}
      </div>
      <p className="gif-panel__credit">{t(giphy ? 'gif.poweredByGiphy' : 'gif.poweredBy')}</p>
    </div>
  );
}
