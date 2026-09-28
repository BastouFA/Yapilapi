'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Icon, Select, TextField } from '@yapilapi/design-system';
import {
  MARKET_CATEGORIES,
  MARKET_CONDITIONS,
  MARKET_DEFAULT_RADIUS_KM,
  MARKET_RADII_KM,
  type MarketCategory,
  type MarketCondition,
  type MarketListing,
  type MarketRadius,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { categoryLabel, conditionLabel, ListingGrid, SellNote, useApproxHere, useMarketMe } from '@/components/Market';
import { useSession } from '../../providers';

type Filters = {
  q: string;
  category: MarketCategory | '';
  conditions: MarketCondition[];
  min: string;
  max: string;
  freeOnly: boolean;
  radiusKm: MarketRadius;
};

const NONE: Filters = { q: '', category: '', conditions: [], min: '', max: '', freeOnly: false, radiusKm: MARKET_DEFAULT_RADIUS_KM };

/** A whole amount typed in a price filter, in hundredths; undefined when empty or not a number. */
function wholeCents(text: string): number | undefined {
  const n = Number(text.trim().replace(/[\s,]/g, ''));
  return text.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n) * 100 : undefined;
}

/**
 * Market: things people near you are selling. Without a place, the newest listings in your country
 * come first; "Use my approximate location" asks the browser once, snaps the answer to about a
 * kilometre here, and shows what's within the distance you choose, nearest first.
 */
export default function MarketPage() {
  const { t, toast } = useSession();
  const market = useMarketMe();
  const place = useApproxHere();
  // What's typed; `applied` is what the results are for (words and prices apply on Search).
  const [draft, setDraft] = useState<Filters>(NONE);
  const [applied, setApplied] = useState<Filters>(NONE);
  const [items, setItems] = useState<MarketListing[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [said, setSaid] = useState('');
  const seq = useRef(0);

  const query = useCallback(
    (f: Filters, near: typeof place.here, next?: string) => {
      const min = wholeCents(f.min);
      const max = wholeCents(f.max);
      return api.market.search({
        ...(near ? { near, radiusKm: f.radiusKm } : {}),
        q: f.q.trim() || undefined,
        category: f.category || undefined,
        conditions: f.conditions.length ? f.conditions : undefined,
        minPriceCents: f.freeOnly ? undefined : min,
        maxPriceCents: f.freeOnly ? undefined : max,
        freeOnly: f.freeOnly || undefined,
        cursor: next,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    const mine = ++seq.current;
    setItems(null);
    query(applied, place.here).then(
      (r) => {
        if (mine !== seq.current) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setSaid(r.items.length ? t('market.browse.updated') : t('market.browse.emptyTitle'));
      },
      (e) => {
        if (mine !== seq.current) return;
        setItems([]);
        setCursor(null);
        toast(errorMessage(e));
      },
    );
  }, [applied, place.here, query, t, toast]);

  /** Choices that don't need typing apply at once; words and prices typed but not searched yet stay as they are. */
  const choose = (patch: Partial<Filters>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setApplied((a) => ({ ...a, ...patch }));
  };
  const filtered = !!(applied.q || applied.category || applied.conditions.length || applied.min || applied.max || applied.freeOnly);

  return (
    <div className="yp-shell__inner yp-shell__inner--wide market">
      <div className="yp-topbar">
        <h1>{t('market.title')}</h1>
        <div className="row">
          <Link href="/market/mine" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('market.yours')}
          </Link>
          <Link href="/market/mine?tab=saved" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('market.saved')}
          </Link>
          {market?.canSell ? (
            <Link href="/market/new" className="yp-btn yp-btn--primary yp-btn--sm">
              {t('market.sell')}
            </Link>
          ) : null}
        </div>
      </div>
      <p className="muted market__intro">{t('market.intro')}</p>
      {market && !market.canSell ? <SellNote market={market} /> : null}

      <form
        role="search"
        aria-label={t('market.browse.search')}
        className="market-search"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(draft);
        }}
      >
        <div className="market-search__row">
          <label htmlFor="market-q" className="yp-visually-hidden">
            {t('market.browse.search')}
          </label>
          <input
            id="market-q"
            type="search"
            className="yp-input"
            placeholder={t('market.browse.placeholder')}
            value={draft.q}
            maxLength={100}
            onChange={(e) => setDraft({ ...draft, q: e.currentTarget.value })}
          />
          <Button type="submit" icon="search">
            {t('market.browse.searchButton')}
          </Button>
        </div>

        <div className="market-near">
          {place.here ? (
            <>
              <p className="market-near__on">
                <Icon name="map-pin" size={16} /> <span>{t('market.browse.nearOn')}</span>
              </p>
              <Select
                label={t('market.browse.radius')}
                value={String(applied.radiusKm)}
                onChange={(e) => choose({ radiusKm: Number(e.currentTarget.value) as MarketRadius })}
                className="market-near__radius"
              >
                {MARKET_RADII_KM.map((r) => (
                  <option key={r} value={r}>
                    {t('market.browse.within', { km: r })}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="sm" onClick={place.forget}>
                {t('market.browse.nearOff')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" icon="map-pin" loading={place.busy} onClick={() => void place.locate()} aria-describedby="market-near-note">
                {t('market.geo.use')}
              </Button>
              <p id="market-near-note" className="muted market-near__note">
                {t('market.browse.nearNote')}
              </p>
            </>
          )}
        </div>

        <details className="market-filters" open={filtered || undefined}>
          <summary>{t('market.browse.filters')}</summary>
          <div className="market-filters__grid">
            <Select
              label={t('market.form.category')}
              value={applied.category}
              onChange={(e) => choose({ category: e.currentTarget.value as MarketCategory | '' })}
            >
              <option value="">{t('market.browse.allCategories')}</option>
              {MARKET_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(t, c)}
                </option>
              ))}
            </Select>
            <fieldset className="market-filters__group">
              <legend className="yp-field__label">{t('market.form.condition')}</legend>
              {MARKET_CONDITIONS.map((c) => (
                <Checkbox
                  key={c}
                  label={conditionLabel(t, c)}
                  checked={applied.conditions.includes(c)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    choose({ conditions: on ? [...applied.conditions, c] : applied.conditions.filter((x) => x !== c) });
                  }}
                />
              ))}
            </fieldset>
            <fieldset className="market-filters__group">
              <legend className="yp-field__label">{t('market.form.price')}</legend>
              <Checkbox label={t('market.browse.freeOnly')} checked={applied.freeOnly} onChange={(e) => choose({ freeOnly: e.currentTarget.checked })} />
              {!applied.freeOnly ? (
                <div className="market-filters__prices">
                  <TextField
                    label={t('market.browse.min', { currency: market?.currency ?? '' })}
                    inputMode="numeric"
                    value={draft.min}
                    onChange={(e) => setDraft({ ...draft, min: e.currentTarget.value })}
                  />
                  <TextField
                    label={t('market.browse.max', { currency: market?.currency ?? '' })}
                    inputMode="numeric"
                    value={draft.max}
                    onChange={(e) => setDraft({ ...draft, max: e.currentTarget.value })}
                  />
                </div>
              ) : null}
              {!applied.freeOnly ? <p className="muted market-filters__hint">{t('market.browse.priceHint')}</p> : null}
            </fieldset>
          </div>
          <div className="row">
            <Button type="submit" size="sm">
              {t('market.browse.apply')}
            </Button>
            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const reset = { ...NONE, radiusKm: applied.radiusKm };
                  setDraft(reset);
                  setApplied(reset);
                }}
              >
                {t('market.browse.clear')}
              </Button>
            ) : null}
          </div>
        </details>
      </form>

      <h2 className="section-title" style={{ margin: 0 }}>
        {place.here ? t('market.browse.nearTitle', { km: applied.radiusKm }) : t('market.browse.newestTitle')}
      </h2>
      <span className="yp-visually-hidden" role="status">
        {said}
      </span>
      <ListingGrid
        items={items}
        label={t('market.browse.results')}
        empty={{
          title: t('market.browse.emptyTitle'),
          body: place.here ? t('market.browse.emptyNear') : t('market.browse.empty'),
        }}
      />
      {cursor && items ? (
        <Button
          variant="secondary"
          loading={more}
          onClick={async () => {
            setMore(true);
            try {
              const r = await query(applied, place.here, cursor);
              setItems((cur) => [...(cur ?? []), ...r.items.filter((x) => !cur?.some((y) => y.id === x.id))]);
              setCursor(r.nextCursor);
              setSaid(t('market.browse.more'));
            } catch (e) {
              toast(errorMessage(e));
            } finally {
              setMore(false);
            }
          }}
        >
          {t('market.browse.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}
