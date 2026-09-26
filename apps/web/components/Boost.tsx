'use client';

import { useMemo, useState } from 'react';
import { Alert, BottomSheet, Button, Segments, Select, TextField } from '@yapilapi/design-system';
import { BOOST_DAYS, BOOST_OPTIONS, currencyForCountry, formatMoney, type Post } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';
import { useCheckout } from './Checkout';

/** Countries offered for a boost audience. The one on your profile is always included. */
const COUNTRIES = ['NG', 'GH', 'KE', 'ZA', 'CI', 'SN', 'CM', 'UG', 'TZ', 'RW', 'ET', 'EG', 'MA', 'US', 'CA', 'GB', 'FR', 'DE', 'BR', 'IN'];

/**
 * Boost one of your public posts, on one screen: a budget, how many days, and
 * who sees it (people in a country, or people interested in a topic). It's
 * paid through checkout, then reviewed like any ad before it runs.
 */
export function BoostSheet({ post, onClose, onDone }: { post: Post | null; onClose: () => void; onDone?: () => void }) {
  return (
    <BottomSheet open={!!post} onClose={onClose} title="Boost this post">
      {post ? <BoostForm key={post.id} post={post} onClose={onClose} onDone={onDone} /> : null}
    </BottomSheet>
  );
}

function BoostForm({ post, onClose, onDone }: { post: Post; onClose: () => void; onDone?: () => void }) {
  const { me, toast, locale } = useSession();
  const checkout = useCheckout();
  const [currency, setCurrency] = useState<string>(() => {
    const c = currencyForCountry(me?.country);
    return BOOST_OPTIONS[c] ? c : 'USD';
  });
  const options = BOOST_OPTIONS[currency]!;
  const [budget, setBudget] = useState<number>(options.budgets[0]!);
  const [days, setDays] = useState<number>(3);
  const [audience, setAudience] = useState<'country' | 'interests'>('country');
  const [country, setCountry] = useState(me?.country ?? 'NG');
  const [topics, setTopics] = useState(post.topics.slice(0, 3).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const regionNames = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      return null;
    }
  }, [locale]);
  const countries = [...new Set([...(me?.country ? [me.country] : []), ...COUNTRIES])];
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
          setError('Add at least one interest, like food or music.');
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
            label: `Boost for ${days} ${days === 1 ? 'day' : 'days'}, ${formatMoney(budget, currency, locale)}`,
            onPaid: () => {
              toast('Paid. Your boost starts once it has been reviewed.');
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
          label="Currency"
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
        <Select label="Budget" value={String(budget)} onChange={(e) => setBudget(Number(e.currentTarget.value))}>
          {options.budgets.map((b) => (
            <option key={b} value={b}>
              {formatMoney(b, currency, locale)}
            </option>
          ))}
        </Select>
        <Select label="How long" value={String(days)} onChange={(e) => setDays(Number(e.currentTarget.value))}>
          {BOOST_DAYS.map((d) => (
            <option key={d} value={d}>
              {d === 1 ? '1 day' : `${d} days`}
            </option>
          ))}
        </Select>
      </div>
      <Segments
        label="Who sees it"
        value={audience}
        onChange={setAudience}
        options={[
          { id: 'country', label: 'People in a country' },
          { id: 'interests', label: 'People with an interest' },
        ]}
      />
      {audience === 'country' ? (
        <Select label="Country" value={country} onChange={(e) => setCountry(e.currentTarget.value)}>
          {countries.map((c) => (
            <option key={c} value={c}>
              {regionNames?.of(c) ?? c}
            </option>
          ))}
        </Select>
      ) : (
        <TextField
          label="Interests"
          hint="Separate them with commas, for example: food, music, lagos"
          value={topics}
          onChange={(e) => setTopics(e.currentTarget.value)}
          maxLength={300}
        />
      )}
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        About {new Intl.NumberFormat(locale).format(reach)} views for {formatMoney(budget, currency, locale)}. Shown as a sponsored post to adults who chose to
        see ads. It starts once a moderator has reviewed it, runs for {days === 1 ? '1 day' : `${days} days`}, and anything it doesn&apos;t spend is refunded.
      </p>
      <Button type="submit" loading={busy}>
        Continue to payment
      </Button>
    </form>
  );
}
