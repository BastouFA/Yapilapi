'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button, Icon, Segments, TextField } from '@yapilapi/design-system';
import type { AskTopic, MapBox } from '@yapilapi/shared';
import { api, ApiError } from '@/lib/api';
import { PostList } from '@/components/PostList';
import { FeatureOff } from '@/components/FeatureOff';
import { AskForm, HelperCard, TopicChips } from '@/components/AskCity';
import { useSession } from '../../providers';

/** ?south&west&north&east from Near you: the part of the map a question can be about. */
function boxFrom(q: URLSearchParams): MapBox | null {
  const n = (k: string) => (q.has(k) ? Number(q.get(k)) : NaN);
  const b = { south: n('south'), west: n('west'), north: n('north'), east: n('east') };
  return Object.values(b).every(Number.isFinite) && b.north > b.south && b.east > b.west ? b : null;
}

/**
 * Ask the city (docs/product/ask-the-city.md): open questions near you (your city, one you search
 * for, or the part of the map you came from), those waiting for an answer first, by topic; your own
 * questions; asking one (by voice or in writing); and "Help answer questions near me". Answers are
 * the comments under each question, by voice or text; the asker marks the helpful ones.
 */
export default function AskCityPage() {
  const { t, flags } = useSession();
  const [tab, setTab] = useState<'near' | 'mine'>('near');
  const [asking, setAsking] = useState(false);
  const [box, setBox] = useState<MapBox | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [listed, setListed] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [topic, setTopic] = useState<AskTopic | null>(null);
  const [reload, setReload] = useState(0);
  const [off, setOff] = useState(false);
  const [ready, setReady] = useState(false);

  // From Near you: the map's area, and "Ask" open.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    setBox(boxFrom(q));
    if (q.get('ask') === '1') setAsking(true);
    if (q.get('city')) setCity(q.get('city'));
    setReady(true);
  }, []);

  const load = useCallback(
    async (cursor?: string) => {
      try {
        const r = await api.askCity.list({ ...(box ? { box } : city ? { city } : {}), ...(topic ? { topic } : {}), cursor });
        setListed(r.city);
        return r;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'feature_disabled') setOff(true);
        throw e;
      }
    },
    [box, city, topic],
  );
  const loadMine = useCallback((cursor?: string) => api.askCity.mine(cursor), []);

  if (off || flags.ASK_CITY === false) return <FeatureOff name={t('askCity.title')} />;

  function findCity(e: FormEvent) {
    e.preventDefault();
    if (!search.trim()) return;
    setBox(null);
    setCity(search.trim());
  }

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>{t('askCity.title')}</h1>
        {flags.CITY_MAP !== false ? (
          <Link href="/map" className="yp-btn yp-btn--ghost yp-btn--sm">
            <Icon name="map-pin" size={16} /> {t('map.title')}
          </Link>
        ) : null}
      </div>
      <p className="muted">{t('askCity.hint')}</p>

      {asking ? (
        <AskForm
          city={listed ?? city}
          box={box}
          onCancel={() => setAsking(false)}
          onAsked={() => {
            setAsking(false);
            setReload((n) => n + 1);
          }}
        />
      ) : (
        <div className="row">
          <Button icon="help" onClick={() => setAsking(true)}>
            {t('askCity.ask')}
          </Button>
        </div>
      )}

      <Segments
        label={t('askCity.title')}
        value={tab}
        onChange={setTab}
        options={[
          { id: 'near', label: t('map.title') },
          { id: 'mine', label: t('askCity.mine') },
        ]}
      />

      {tab === 'near' ? (
        <>
          <form className="askcity-city" onSubmit={findCity} role="search">
            <TextField label={t('map.searchCity')} value={search} maxLength={60} onChange={(e) => setSearch(e.currentTarget.value)} />
            <Button type="submit" variant="ghost">
              {t('home.search')}
            </Button>
          </form>
          {box ? <p className="askcity-in">{t('askCity.mapArea')}</p> : listed ? <h2 className="askcity-in">{t('askCity.in', { city: listed })}</h2> : null}
          <TopicChips value={topic} onChange={setTopic} label={t('askCity.topic')} all />
          {ready ? (
            <PostList
              load={load}
              reloadKey={`${box ? JSON.stringify(box) : (city ?? '')}:${topic ?? ''}:${reload}`}
              showEnd={false}
              emptyTitle={t('askCity.title')}
              empty={listed || box ? t('askCity.empty') : t('askCity.noCity')}
            />
          ) : null}
          <HelperCard />
        </>
      ) : (
        <PostList load={loadMine} reloadKey={`mine:${reload}`} showEnd={false} emptyTitle={t('askCity.mine')} empty={t('askCity.empty')} />
      )}
    </div>
  );
}
