'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button, Icon, Segments } from '@yapilapi/design-system';
import { LAUNCH_CITIES, type LatLng, type LaunchCityKey, type StashCard, type StashExplorerRow } from '@yapilapi/shared';
import { api, ApiError, errorMessage } from '@/lib/api';
import { FeatureOff } from '@/components/FeatureOff';
import { useApproxHere } from '@/components/Market';
import { Person, StashRow, StashSettingsFields } from '@/components/Stash';
import { useSession } from '../../providers';

/**
 * The Stash page (docs/product/stash.md): stashes near you (by their area), hide one, this month's
 * top explorers in a launch city, the stashes you hid and found, and your stash settings.
 */
export default function StashHome() {
  const { t, tp, flags } = useSession();
  const place = useApproxHere();
  const [from, setFrom] = useState<LatLng | null>(null);
  const [near, setNear] = useState<{ stash: StashCard; metres: number | null }[] | null>(null);
  const [mine, setMine] = useState<{ hidden: StashCard[]; found: StashCard[] } | null>(null);
  const [tab, setTab] = useState<'hidden' | 'found'>('found');
  const [city, setCity] = useState<LaunchCityKey>('lagos');
  const [explorers, setExplorers] = useState<StashExplorerRow[] | null>(null);
  const [off, setOff] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // Where to look: where you are (when asked), else your profile's city, else Lagos.
  useEffect(() => {
    api.map
      .center()
      .then(({ center }) => setFrom((f) => f ?? center?.center ?? LAUNCH_CITIES[0].center))
      .catch(() => setFrom((f) => f ?? LAUNCH_CITIES[0].center));
    api.stash.mine().then(setMine, (e) => e instanceof ApiError && e.code === 'feature_disabled' && setOff(true));
  }, []);
  useEffect(() => {
    if (place.here) setFrom(place.here);
  }, [place.here]);
  useEffect(() => {
    if (!from) return;
    api.stash.near(from).then(
      (r) => setNear(r.items),
      (e) => setProblem(errorMessage(e)),
    );
  }, [from]);
  useEffect(() => {
    setExplorers(null);
    api.stash.explorers(city).then(
      (r) => setExplorers(r.items),
      () => setExplorers([]),
    );
  }, [city]);

  if (off || flags.STASH === false) return <FeatureOff name={t('stash.title')} />;
  const cityName = LAUNCH_CITIES.find((c) => c.key === city)!.name;
  const list = mine ? mine[tab] : [];

  return (
    <div className="yp-shell__inner stack">
      <div className="yp-topbar">
        <h1>{t('stash.title')}</h1>
      </div>
      <p className="muted">{t('stash.hint')}</p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Link href="/stash/new" className="yp-btn yp-btn--primary">
          <Icon name="map-pin" size={18} /> {t('stash.hide')}
        </Link>
        <Button variant="secondary" icon="map-pin" loading={place.busy} onClick={() => void place.locate()}>
          {t('map.useLocation')}
        </Button>
      </div>

      <section className="near-section" aria-labelledby="stash-near">
        <h2 id="stash-near">{t('stash.near')}</h2>
        <div className="near-page__picks" role="group" aria-label={t('near.pickCity')}>
          <span className="muted">{t('near.pickCity')}</span>
          {LAUNCH_CITIES.map((c) => (
            <Button key={c.key} size="sm" variant="ghost" onClick={() => setFrom(c.center)}>
              {c.name}
            </Button>
          ))}
        </div>
        {problem ? <p className="muted">{problem}</p> : null}
        {near && !near.length ? <p className="muted">{t('stash.nearEmpty')}</p> : null}
        <ul className="citymap__list">
          {near?.map((n) => (
            <li key={n.stash.id}>
              <StashRow stash={n.stash} metres={n.metres} />
            </li>
          ))}
        </ul>
      </section>

      <section className="near-section" aria-labelledby="stash-explorers">
        <h2 id="stash-explorers">{t('stash.explorers', { city: cityName })}</h2>
        <Segments label={t('near.pickCity')} value={city} onChange={setCity} options={LAUNCH_CITIES.map((c) => ({ id: c.key, label: c.name }))} />
        {explorers && !explorers.length ? <p className="muted">{t('stash.explorersEmpty')}</p> : null}
        <ol className="stack stash-finds">
          {explorers?.map((x) => (
            <li key={x.user.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Link href={`/u/${x.user.username}`}>
                <Person name={x.user.displayName} src={x.user.avatarUrl} />
              </Link>
              <span className="muted">{tp('stash.explorerFinds', x.finds)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="near-section" aria-label={t('stash.mine')}>
        <Segments
          label={t('stash.title')}
          value={tab}
          onChange={setTab}
          options={[
            { id: 'found', label: t('stash.found') },
            { id: 'hidden', label: t('stash.mine') },
          ]}
        />
        <ul className="citymap__list">
          {list.map((s) => (
            <li key={s.id}>
              <StashRow stash={s} />
            </li>
          ))}
        </ul>
      </section>

      <section className="near-section" aria-labelledby="stash-settings">
        <h2 id="stash-settings">{t('settings.title')}</h2>
        <StashSettingsFields />
      </section>
    </div>
  );
}
