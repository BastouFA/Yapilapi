'use client';

import { useMemo, useState } from 'react';
import { Alert, BottomSheet, Button, Segments, Select, TextField } from '@yapilapi/design-system';
import { BOOST_DAYS, BOOST_OPTIONS, currencyForCountry, formatMoney, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useCheckout } from './Checkout';

/** Countries offered for a boost audience. The one on your profile is always included. */
const COUNTRIES = ['NG', 'GH', 'KE', 'ZA', 'CI', 'SN', 'CM', 'UG', 'TZ', 'RW', 'ET', 'EG', 'MA', 'US', 'CA', 'GB', 'FR', 'DE', 'BR', 'IN'];

/** Choices made elsewhere (the phone app's boost screen) to start the form with. Anything not offered is ignored. */
export interface BoostChoices {
  currency?: string;
  budgetCents?: number;
  days?: number;
  country?: string;
  topics?: string[];
}

/** Boost choices from a link's query (?currency=&budget=&days=&country= or &topics=a,b). */
export function boostChoicesFrom(q: URLSearchParams): BoostChoices {
  const num = (k: string) => (q.get(k) && /^\d+$/.test(q.get(k)!) ? Number(q.get(k)) : undefined);
  return {
    currency: q.get('currency')?.toUpperCase() || undefined,
    budgetCents: num('budget'),
    days: num('days'),
    country: /^[A-Za-z]{2}$/.test(q.get('country') ?? '') ? q.get('country')!.toUpperCase() : undefined,
    topics: q
      .get('topics')
      ?.split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 10),
  };
}

/**
 * Boost one of your public posts, on one screen: a budget, how many days, and
 * who sees it (people in a country, or people interested in a topic). It's
 * paid through checkout, then reviewed like any ad before it runs.
 */
export function BoostSheet({ post, onClose, onDone, choices }: { post: Post | null; onClose: () => void; onDone?: () => void; choices?: BoostChoices }) {
  const { t } = useSession();
  return (
    <BottomSheet open={!!post} onClose={onClose} title={t('m.boost.title')}>
      {post ? <BoostForm key={post.id} post={post} onClose={onClose} onDone={onDone} choices={choices} /> : null}
    </BottomSheet>
  );
}

function BoostForm({ post, onClose, onDone, choices }: { post: Post; onClose: () => void; onDone?: () => void; choices?: BoostChoices }) {
  const { me, toast, locale, t, tp } = useSession();
  const checkout = useCheckout();
  const [currency, setCurrency] = useState<string>(() => {
    if (choices?.currency && BOOST_OPTIONS[choices.currency]) return choices.currency;
    const c = currencyForCountry(me?.country);
    return BOOST_OPTIONS[c] ? c : 'USD';
  });
  const options = BOOST_OPTIONS[currency]!;
  const [budget, setBudget] = useState<number>(() =>
    choices?.budgetCents && options.budgets.includes(choices.budgetCents) ? choices.budgetCents : options.budgets[0]!,
  );
  const [days, setDays] = useState<number>(() => (choices?.days && (BOOST_DAYS as readonly number[]).includes(choices.days) ? choices.days : 3));
  const [audience, setAudience] = useState<'country' | 'interests'>(choices?.topics?.length ? 'interests' : 'country');
  const [country, setCountry] = useState(choices?.country ?? me?.country ?? 'NG');
  const [topics, setTopics] = useState((choices?.topics?.length ? choices.topics : post.topics.slice(0, 3)).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      return null;
    }
  }, [locale]);
  const countries = [...new Set([...(me?.country ? [me.country] : []), ...(choices?.country ? [choices.country] : []), ...COUNTRIES])];
  const topicList = topics
    .split(',')
    .map((x) => x.trim().replace(/^#/, '').toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
  const reach = Math.floor((budget / options.cpmCents) * 1000);

  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (audience === 'interests' && !topicList.length) {
          setError(t('boost.needInterest'));
          return;
        }
        setBusy(true);
        try {
          const r = await api.boosts.start(post.id, {
            budgetCents: budget,
            currency,
            days,
            audience: audience === 'country' ? { type: 'country', countries: [country] } : { type: 'interests', topics: topicList },
            idempotencyKey: crypto.randomUUID(),
          });
          onClose();
          checkout({
            orderId: r.payment.orderId,
            clientSecret: r.payment.clientSecret,
            provider: r.payment.provider,
            label: tp('boost.checkoutLabel', days, { price: formatMoney(budget, currency, locale) }),
            onPaid: () => {
              toast(t('boost.paid'));
              onDone?.();
            },
          });
          onDone?.();
        } catch (err) {
          setError(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <div className="row">
        <Select
          label={t('m.boost.currency')}
          value={currency}
          onChange={(e) => {
            const c = e.currentTarget.value;
            setCurrency(c);
            setBudget(BOOST_OPTIONS[c]!.budgets[0]!);
          }}
        >
          {Object.keys(BOOST_OPTIONS).map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <Select label={t('m.boost.budget')} value={String(budget)} onChange={(e) => setBudget(Number(e.currentTarget.value))}>
          {options.budgets.map((b) => (
            <option key={b} value={b}>
              {formatMoney(b, currency, locale)}
            </option>
          ))}
        </Select>
        <Select label={t('m.boost.howLong')} value={String(days)} onChange={(e) => setDays(Number(e.currentTarget.value))}>
          {BOOST_DAYS.map((d) => (
            <option key={d} value={d}>
              {tp('m.boost.days', d)}
            </option>
          ))}
        </Select>
      </div>
      <Segments
        label={t('m.boost.who')}
        value={audience}
        onChange={setAudience}
        options={[
          { id: 'country', label: t('m.boost.country') },
          { id: 'interests', label: t('m.boost.interests') },
        ]}
      />
      {audience === 'country' ? (
        <Select label={t('m.boost.countryLabel')} value={country} onChange={(e) => setCountry(e.currentTarget.value)}>
          {countries.map((c) => (
            <option key={c} value={c}>
              {regionNames?.of(c) ?? c}
            </option>
          ))}
        </Select>
      ) : (
        <TextField
          label={t('m.boost.interestsLabel')}
          hint={t('boost.interestsHint')}
          value={topics}
          onChange={(e) => setTopics(e.currentTarget.value)}
          maxLength={300}
        />
      )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {tp('boost.summary', days, { views: new Intl.NumberFormat(locale).format(reach), price: formatMoney(budget, currency, locale) })}
      </p>
      <Button type="submit" loading={busy}>
        {t('shop.continuePayment')}
      </Button>
    </form>
  );
}
