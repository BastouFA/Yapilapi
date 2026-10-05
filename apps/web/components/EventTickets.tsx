'use client';

import { useCallback, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, List, ListItem, Select, TextField } from '@yapilapi/design-system';
import type { EventTicketType } from '@yapilapi/api-client';
import { CURRENCIES, formatMoney, type EventItem } from '@yapilapi/shared';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { BuyButton } from '@/components/BuyButton';
import { useSession } from '@/app/providers';

/**
 * Tickets an event sells. Guests buy them through checkout (they land in Tickets); the host puts
 * kinds of ticket on sale and stops selling them. Nothing shows when nothing is on sale, except to
 * the host of an event still to come.
 */
export function EventTickets({ event, hosting, over, onBought }: { event: EventItem; hosting: boolean; over: boolean; onBought?: () => void }) {
  const { t, tp, toast, locale, flags, me } = useSession();
  // Selling is for adults (the server says so too).
  const canSell = hosting && !over && !me?.under18;
  const [items, setItems] = useState<EventTicketType[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoadError(null);
    api.events.ticketTypes(event.id).then(
      (r) => setItems(r.items),
      (e) => setLoadError(errorMessage(e)),
    );
  }, [event.id]);
  useEffect(() => {
    load();
  }, [load]);

  if (flags.COMMERCE === false) return null;
  if (loadError)
    return (
      <Alert tone="danger">
        {loadError}{' '}
        <Button size="sm" variant="ghost" onClick={load}>
          {t('m.common.retry')}
        </Button>
      </Alert>
    );
  if (!items || (!items.length && !canSell)) return null;
  const price = (x: EventTicketType) => (x.priceCents ? formatMoney(x.priceCents, x.currency, locale) : t('eventTickets.free'));

  return (
    <Card title={t('eventTickets.title')} subtitle={canSell ? t('eventTickets.sellHint') : undefined}>
      <div className="stack-sm">
        {items.length ? (
          <List label={t('eventTickets.title')}>
            {items.map((x) => (
              <ListItem
                key={x.id}
                primary={x.title}
                secondary={[price(x), x.inventory !== null && !x.soldOut ? tp('m.product.left', x.inventory) : null].filter(Boolean).join(' · ')}
                end={
                  hosting ? (
                    over ? null : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api.events.stopSellingTickets(event.id, x.id);
                            toast(t('eventTickets.stopped'));
                            load();
                          } catch (e) {
                            toast(errorMessage(e));
                          }
                        }}
                      >
                        {t('eventTickets.stop')}
                      </Button>
                    )
                  ) : x.soldOut ? (
                    <Badge tone="neutral">{t('shop.soldOut')}</Badge>
                  ) : over ? null : (
                    <BuyButton
                      productId={x.id}
                      onPaid={() => {
                        toast(t('eventTickets.bought'));
                        load();
                        onBought?.();
                      }}
                    />
                  )
                }
              />
            ))}
          </List>
        ) : null}
        {canSell ? <SellTickets eventId={event.id} onAdded={load} /> : null}
      </div>
    </Card>
  );
}

function SellTickets({ eventId, onAdded }: { eventId: string; onAdded: () => void }) {
  const { t, toast } = useSession();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>('USD');
  const [quantity, setQuantity] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const cents = amount.trim() === '' ? NaN : Math.round(Number(amount.replace(',', '.')) * 100);
  const qty = quantity.trim() ? Number(quantity) : null;
  const ready = !!title.trim() && Number.isFinite(cents) && cents >= 0 && (qty === null || (Number.isInteger(qty) && qty > 0));

  if (!open)
    return (
      <div>
        <Button size="sm" variant="secondary" icon="ticket" onClick={() => setOpen(true)}>
          {t('eventTickets.sell')}
        </Button>
      </div>
    );
  return (
    <form
      className="stack-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setError(null);
        setFields({});
        try {
          await api.events.sellTickets(eventId, { title: title.trim(), priceCents: cents, currency, ...(qty ? { inventory: qty } : {}) });
          setTitle('');
          setAmount('');
          setQuantity('');
          setOpen(false);
          toast(t('eventTickets.added'));
          onAdded();
        } catch (err) {
          setError(errorMessage(err));
          setFields(fieldErrors(err));
        } finally {
          setBusy(false);
        }
      }}
    >
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <TextField
        label={t('eventTickets.name')}
        placeholder={t('eventTickets.namePlaceholder')}
        value={title}
        onChange={(e) => setTitle(e.currentTarget.value)}
        maxLength={120}
        required
        error={fields.title}
      />
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <TextField
          label={t('m.drops.form.price')}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          hint={t('eventTickets.priceHint')}
          error={fields.priceCents ?? (amount && !(Number.isFinite(cents) && cents >= 0) ? t('eventTickets.priceInvalid') : undefined)}
        />
        <Select label={t('m.boost.currency')} value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </div>
      <TextField
        label={t('m.drops.form.quantity')}
        type="number"
        min={1}
        step={1}
        value={quantity}
        onChange={(e) => setQuantity(e.currentTarget.value)}
        hint={t('m.drops.form.quantityHint')}
        error={fields.inventory}
      />
      <div className="row">
        <Button type="submit" size="sm" loading={busy} disabled={!ready}>
          {t('eventTickets.add')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
