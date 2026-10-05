'use client';

import { useEffect, useState } from 'react';
import { Button, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import { CURRENCY_SCALE, EARNINGS_HOLD_DAYS, PAYOUT_MIN_CENTS, currencyForCountry, formatMoney, formatRelativeTime, type Currency } from '@yapilapi/shared';
import type { Payout, PayoutAccount } from '@yapilapi/api-client';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/app/providers';

type Balance = { currency: string; availableCents: number };

/**
 * Studio's payouts: where the money goes in a currency (a Stripe account set up on Stripe's page, or a bank
 * account given here), asking for a payout of what's available, and the payouts so far.
 */
/** `onRequested` reloads the balances above, which a request takes from. */
export function PayoutsPanel({ balances, onRequested }: { balances: Balance[]; onRequested: () => void }) {
  const { me, toast, locale, t } = useSession();
  const currencies = balances.length ? balances.map((b) => b.currency) : [currencyForCountry(me?.country)];
  const [currency, setCurrency] = useState(currencies[0]!);
  const [accounts, setAccounts] = useState<PayoutAccount[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => {
    api.creator.payoutAccounts().then(
      (r) => setAccounts(r.items),
      () => {},
    );
    api.creator.payouts().then(
      (r) => setPayouts(r.items),
      () => {},
    );
  };
  useEffect(load, []);
  const account = accounts.find((a) => a.currency === currency);
  const available = balances.find((b) => b.currency === currency)?.availableCents ?? 0;
  const min = PAYOUT_MIN_CENTS * (CURRENCY_SCALE[currency as Currency] ?? 1);

  return (
    <section className="stack-sm" id="payouts">
      <h2 className="section-title">{t('studio.payouts.title')}</h2>
      <p className="muted" style={{ margin: 0 }}>
        {t('studio.payouts.intro', { days: EARNINGS_HOLD_DAYS, min: formatMoney(min, currency, locale) })}
      </p>
      {currencies.length > 1 ? (
        <Select label={t('studio.payouts.currency')} value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
          {currencies.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
      ) : null}
      {account ? <AccountSetup account={account} onSaved={load} /> : null}
      {account?.ready ? (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await api.creator.requestPayout(Math.round(Number(amount) * 100), currency);
              setAmount('');
              toast(t('studio.payouts.requested'));
              load();
              onRequested();
            } catch (err) {
              toast(errorMessage(err));
            } finally {
              setBusy(false);
            }
          }}
        >
          <TextField
            label={t('studio.payouts.amount', { currency })}
            type="number"
            min={min / 100}
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            hint={t('studio.payouts.available', { amount: formatMoney(Math.max(0, available), currency, locale) })}
          />
          <Button type="submit" disabled={busy || !amount || available < min} style={{ alignSelf: 'flex-end' }}>
            {t('studio.payouts.request')}
          </Button>
        </form>
      ) : null}
      <h3 className="section-title" style={{ fontSize: 16 }}>
        {t('studio.payouts.history')}
      </h3>
      {payouts.length ? (
        <List>
          {payouts.map((p) => (
            <ListItem
              key={p.id}
              primary={formatMoney(p.amountCents, p.currency, locale)}
              secondary={[formatRelativeTime(p.createdAt, locale), p.status === 'failed' ? p.failureReason : null].filter(Boolean).join(' · ')}
              end={t(`studio.payouts.status.${p.status}`)}
            />
          ))}
        </List>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          {t('studio.payouts.none')}
        </p>
      )}
    </section>
  );
}

/** How payouts in one currency are set up: the provider's page, or a bank account form. */
function AccountSetup({ account, onSaved }: { account: PayoutAccount; onSaved: () => void }) {
  const { toast, t } = useSession();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!account.kind) return <p className="muted">{t('studio.payouts.unavailable', { currency: account.currency })}</p>;

  if (account.kind === 'hosted')
    return account.ready ? (
      <p style={{ margin: 0 }}>{t('studio.payouts.toStripe')}</p>
    ) : (
      <div className="stack-sm">
        <p className="muted" style={{ margin: 0 }}>
          {t('studio.payouts.hostedIntro')}
        </p>
        <Button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              window.location.href = (await api.creator.startPayoutOnboarding(account.currency)).url;
            } catch (err) {
              toast(errorMessage(err));
              setBusy(false);
            }
          }}
        >
          {account.label === null && !account.ready ? t('studio.payouts.setUp') : t('studio.payouts.finishSetup')}
        </Button>
      </div>
    );

  if (account.ready && !editing)
    return (
      <div className="row" style={{ alignItems: 'center' }}>
        <p style={{ margin: 0 }}>{t('studio.payouts.toAccount', { account: account.label ?? '' })}</p>
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          {t('studio.payouts.change')}
        </Button>
      </div>
    );
  return (
    <BankForm
      currency={account.currency}
      onSaved={() => {
        setEditing(false);
        onSaved();
      }}
    />
  );
}

function BankForm({ currency, onSaved }: { currency: string; onSaved: () => void }) {
  const { toast, t } = useSession();
  const [banks, setBanks] = useState<{ code: string; name: string }[]>([]);
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.creator.payoutBanks(currency).then(
      (r) => setBanks(r.items),
      (e) => toast(errorMessage(e)),
    );
  }, [currency, toast]);
  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api.creator.setPayoutBank({ currency, bankCode, accountNumber, accountName });
          toast(t('studio.payouts.saved'));
          onSaved();
        } catch (err) {
          toast(errorMessage(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Select label={t('studio.payouts.bank')} value={bankCode} onChange={(e) => setBankCode(e.currentTarget.value)} required>
        <option value="">{t('studio.payouts.pickBank')}</option>
        {banks.map((b) => (
          <option key={b.code} value={b.code}>
            {b.name}
          </option>
        ))}
      </Select>
      <TextField
        label={t('studio.payouts.accountNumber')}
        inputMode="numeric"
        autoComplete="off"
        pattern="[0-9]{6,20}"
        value={accountNumber}
        onChange={(e) => setAccountNumber(e.currentTarget.value.replace(/\D/g, ''))}
        required
      />
      <TextField
        label={t('studio.payouts.accountName')}
        autoComplete="name"
        value={accountName}
        onChange={(e) => setAccountName(e.currentTarget.value)}
        maxLength={100}
        required
      />
      <Button type="submit" disabled={busy || !bankCode || accountNumber.length < 6 || accountName.trim().length < 2}>
        {t('studio.payouts.save')}
      </Button>
    </form>
  );
}
