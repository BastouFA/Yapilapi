'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Icon, Select, TextField } from '@yapilapi/design-system';
import type { ShopItem } from '@yapilapi/api-client';
import {
  CURRENCIES,
  DROP_DESCRIPTION_MAX,
  DROP_MAX_ITEMS,
  DROP_MAX_PER_BUYER,
  DROP_MAX_QUANTITY,
  DROP_TITLE_MAX,
  dropCountdown,
  dropDay,
  dropPhase,
  dropScheduleProblem,
  formatMoney,
  IMAGE_ACCEPT,
  type Drop,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { localInput } from '@/lib/schedule';
import { useRealtime, useSession, type Session } from '@/app/providers';
import { useCheckout } from './Checkout';

/**
 * Drops: product launches announced ahead of time. Cards for profiles and Home, the words for a
 * drop's time (plain, like "Opens Friday at 6:00 PM", never a ticking clock), buying from an
 * open drop, and the seller's form.
 */

/** The current time, moved on every `ms` so relative words stay right. Minutes are enough. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** "Opens today at 6:00 PM", "Opens tomorrow at 9:00 AM", "Opens Friday at 6:00 PM", "Opens Tue, Oct 20 at 6:00 PM". */
export function opensText(t: Session['t'], locale: string, startsAt: string, now = new Date()): string {
  const d = dropDay(startsAt, locale, now);
  if (d.kind === 'today') return t('m.drops.opensToday', { time: d.time });
  if (d.kind === 'tomorrow') return t('m.drops.opensTomorrow', { time: d.time });
  return t('m.drops.opensOn', { day: d.day, time: d.time });
}

/** "in 3 days", "in 5 hours", in the viewer's language. */
export function untilText(locale: string, at: string, now = new Date()): string | null {
  const c = dropCountdown(at, now);
  if (!c) return null;
  try {
    return new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(c.value, c.unit);
  } catch {
    return null;
  }
}

const shortWhen = (locale: string, iso: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** One line for where a drop is: when it opens, that it's open (and until when), or how it ended. */
export function dropStatusText(t: Session['t'], locale: string, d: Drop, now = new Date()): string {
  const phase = dropPhase(d, now);
  if (phase === 'upcoming' || phase === 'draft') {
    const until = untilText(locale, d.startsAt, now);
    const opens = opensText(t, locale, d.startsAt, now);
    return phase === 'draft' ? `${t('m.drops.draft')} · ${opens}` : until ? `${opens} · ${until}` : opens;
  }
  if (phase === 'opening') return t('m.drops.opening');
  if (phase === 'open') return d.endsAt ? t('m.drops.closesOn', { when: shortWhen(locale, d.endsAt) }) : t('m.drops.open');
  if (phase === 'cancelled') return t('m.drops.cancelled');
  return d.endReason === 'sold_out' ? t('m.drops.soldOut') : t('m.drops.ended');
}

/** The cover photo, or the brand gradient with a bag when there is none. */
export function DropCover({ drop, className = 'drop-cover' }: { drop: Pick<Drop, 'coverUrl' | 'coverAlt' | 'title'>; className?: string }) {
  const { t } = useSession();
  return drop.coverUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={className} src={drop.coverUrl} alt={drop.coverAlt || t('m.drops.coverAlt', { title: drop.title })} />
  ) : (
    <span className={`${className} drop-cover--plain`} aria-hidden>
      <Icon name="bag" size={28} />
    </span>
  );
}

/** A drop in a row: cover, name, who, and when. */
export function DropCard({ drop, now, showSeller = true }: { drop: Drop; now: Date; showSeller?: boolean }) {
  const { t, tp, locale } = useSession();
  const phase = dropPhase(drop, now);
  return (
    <Link href={`/drops/${drop.id}`} className="drop-card">
      <DropCover drop={drop} />
      <span className="drop-card__body">
        <span className="drop-card__title" dir="auto">
          {drop.title}
        </span>
        {showSeller ? <span className="drop-card__meta">{t('m.drops.by', { name: drop.seller.displayName })}</span> : null}
        <span className={phase === 'open' || phase === 'opening' ? 'drop-card__when drop-card__when--open' : 'drop-card__when'}>
          {dropStatusText(t, locale, drop, now)}
        </span>
        <span className="drop-card__meta">{tp('m.drops.products', drop.items.length)}</span>
      </span>
    </Link>
  );
}

/** A person's drops on their profile (nothing when they have none). */
export function DropsRow({ userId, isSelf }: { userId: string; isSelf: boolean }) {
  const { t, flags } = useSession();
  const now = useNow();
  const [items, setItems] = useState<Drop[]>([]);
  useEffect(() => {
    api.drops.byUser(userId).then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, [userId]);
  if (flags.COMMERCE === false || !items.length) return null;
  return (
    <section className="drops-row" aria-labelledby="drops-row-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 id="drops-row-title" className="section-title" style={{ margin: 0 }}>
          {t('m.drops.onProfile')}
        </h2>
        {isSelf ? (
          <Link href="/drops" className="yp-btn yp-btn--ghost yp-btn--sm">
            {t('m.drops.yours')}
          </Link>
        ) : null}
      </div>
      <ul className="drops-row__list">
        {items.map((d) => (
          <li key={d.id}>
            <DropCard drop={d} now={now} showSeller={false} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** On Home: open and coming drops from people you follow (nothing when there are none). */
export function FollowingDrops() {
  const { t, flags } = useSession();
  const now = useNow();
  const [items, setItems] = useState<Drop[]>([]);
  useEffect(() => {
    api.drops.following().then(
      (r) => setItems(r.items),
      () => setItems([]),
    );
  }, []);
  if (flags.COMMERCE === false || !items.length) return null;
  return (
    <section className="drops-row" aria-labelledby="following-drops-title">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 id="following-drops-title" className="section-title" style={{ margin: 0 }}>
          {t('m.drops.fromFollowing')}
        </h2>
        <Link href="/drops" className="yp-btn yp-btn--ghost yp-btn--sm">
          {t('m.drops.yours')}
        </Link>
      </div>
      <ul className="drops-row__list">
        {items.map((d) => (
          <li key={d.id}>
            <DropCard drop={d} now={now} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Keep a drop current: realtime changes, and a check each 15 seconds while it's about to open. */
export function useDrop(id: string, enabled = true) {
  const [drop, setDrop] = useState<Drop | null>(null);
  const [missing, setMissing] = useState(false);
  const now = useNow(15_000);
  const load = useCallback(
    () =>
      api.drops.get(id).then(
        (r) => {
          setDrop(r.drop);
          setMissing(false);
        },
        () => setMissing(true),
      ),
    [id],
  );
  useEffect(() => {
    if (enabled) void load();
  }, [load, enabled]);
  useRealtime((e) => {
    if (e.type === 'drop.updated' && (e.data as { id?: string } | undefined)?.id === id) void load();
  });
  const opening = drop ? dropPhase(drop, now) === 'opening' : false;
  useEffect(() => {
    if (opening) void load();
  }, [opening, now, load]);
  return { drop, setDrop, missing, reload: load, now };
}

/**
 * Buy from an open drop through the usual checkout. The amount goes up to what is left, the
 * per-person limit and what you already have; the server checks all of it again.
 */
export function DropBuy({ drop, item, onDone }: { drop: Drop; item: Drop['items'][number]; onDone: () => void }) {
  const { t, toast, locale } = useSession();
  const checkout = useCheckout();
  const [busy, setBusy] = useState(false);
  const caps = [10, item.remaining ?? 10, item.perBuyerLimit !== null ? item.perBuyerLimit - (item.yours ?? 0) : 10];
  const most = Math.max(0, Math.min(...caps));
  const [qty, setQty] = useState(1);
  if (item.soldOut) return <Badge>{t('m.drops.soldOut')}</Badge>;
  if (most < 1) return <span className="muted">{t('m.drops.limitReached')}</span>;
  return (
    <div className="row drop-buy">
      {most > 1 ? (
        <Select label={t('m.drops.amount')} value={String(qty)} onChange={(e) => setQty(Number(e.currentTarget.value))} className="drop-buy__qty">
          {Array.from({ length: most }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      ) : null}
      <Button
        loading={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.orders.create([{ productId: item.productId, quantity: qty }], crypto.randomUUID());
            onDone();
            if (r.order.status === 'paid' || !r.payment) toast(t('m.drops.bought', { count: qty }));
            else
              checkout({
                orderId: r.order.id,
                clientSecret: r.payment.clientSecret,
                provider: r.payment.provider,
                label: `${item.title} × ${qty}, ${formatMoney(r.order.totalCents, r.order.currency, locale)}`,
                onPaid: onDone,
              });
          } catch (e) {
            toast(errorMessage(e));
            onDone();
          } finally {
            setBusy(false);
          }
        }}
        aria-label={`${t('m.drops.buy')}: ${item.title}`}
      >
        {t('m.drops.buy')}
      </Button>
    </div>
  );
}

const PROBLEM_KEY: Record<string, MessageKey> = {
  startInvalid: 'm.drops.problem.startInvalid',
  startTooSoon: 'm.drops.problem.startTooSoon',
  startTooLate: 'm.drops.problem.startTooLate',
  endInvalid: 'm.drops.problem.endInvalid',
  endTooSoon: 'm.drops.problem.endTooSoon',
  endTooLate: 'm.drops.problem.endTooLate',
};

type ItemPick = { productId: string; quantity: string; perBuyerLimit: string };

/** A whole number from a field, or null when it's empty. */
const count = (s: string): number | null => (s.trim() === '' ? null : Number(s));

/**
 * Create or change a drop: name, short description, cover, when it opens (and optionally
 * closes), and which of your products are in it with how many and a per-person limit. Saved as
 * a draft, or saved and published.
 */
export function DropEditor({ drop }: { drop?: Drop }) {
  const { me, t, toast, locale } = useSession();
  const router = useRouter();
  const [shop, setShop] = useState<ShopItem[] | null>(null);
  const [title, setTitle] = useState(drop?.title ?? '');
  const [description, setDescription] = useState(drop?.description ?? '');
  const [starts, setStarts] = useState(() => {
    if (drop) return localInput(new Date(drop.startsAt));
    const d = new Date(Date.now() + 24 * 60 * 60_000);
    d.setMinutes(0, 0, 0);
    return localInput(d);
  });
  const [ends, setEnds] = useState(drop?.endsAt ? localInput(new Date(drop.endsAt)) : '');
  const [picks, setPicks] = useState<ItemPick[]>(
    () =>
      drop?.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity === null ? '' : String(i.quantity),
        perBuyerLimit: i.perBuyerLimit === null ? '' : String(i.perBuyerLimit),
      })) ?? [],
  );
  const [file, setFile] = useState<File | null>(null);
  const [coverAlt, setCoverAlt] = useState(drop?.coverAlt ?? '');
  const [removeCover, setRemoveCover] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'draft' | 'publish' | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  // A new product made right here.
  const [np, setNp] = useState({ title: '', price: '', currency: 'USD' });
  const [npBusy, setNpBusy] = useState(false);

  const loadShop = useCallback(() => {
    if (!me) return;
    api.shop.list(me.id).then(
      (r) => setShop(r.items.filter((p) => p.kind === 'product' || p.kind === 'digital')),
      () => setShop([]),
    );
  }, [me]);
  useEffect(() => loadShop(), [loadShop]);

  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const picked = (id: string) => picks.find((p) => p.productId === id);

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = t('m.drops.form.nameRequired');
    if (!picks.length) e.items = t('m.drops.form.pickOne');
    const p = dropScheduleProblem(new Date(starts), ends ? new Date(ends) : null);
    if (p) e[p.field] = t(PROBLEM_KEY[p.problem]!);
    for (const x of picks) {
      const q = count(x.quantity);
      const l = count(x.perBuyerLimit);
      if (q !== null && !(Number.isInteger(q) && q >= 1 && q <= DROP_MAX_QUANTITY)) e[`q:${x.productId}`] = t('m.drops.form.wholeNumber');
      if (l !== null && !(Number.isInteger(l) && l >= 1 && l <= DROP_MAX_PER_BUYER)) e[`l:${x.productId}`] = t('m.drops.form.wholeNumber');
    }
    return e;
  }

  async function save(publish: boolean) {
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(publish ? 'publish' : 'draft');
    try {
      const body = {
        title: title.trim(),
        description: description.trim(),
        startsAt: new Date(starts).toISOString(),
        endsAt: ends ? new Date(ends).toISOString() : null,
        items: picks.map((p) => ({ productId: p.productId, quantity: count(p.quantity), perBuyerLimit: count(p.perBuyerLimit) })),
      };
      let saved = drop ? (await api.drops.update(drop.id, body)).drop : (await api.drops.create(body)).drop;
      if (file) {
        setStage(t('m.drops.form.uploading'));
        const { media } = await api.media.upload(file, coverAlt.trim() || undefined);
        if (media.kind !== 'image') throw new Error(t('m.drops.form.photoOnly'));
        setStage(t('m.cover.preparing'));
        saved = (await api.drops.setCoverWhenReady(saved.id, media.id, coverAlt.trim() || undefined)).drop;
      } else if (removeCover && saved.coverUrl) saved = (await api.drops.removeCover(saved.id)).drop;
      if (publish && saved.status === 'draft') saved = (await api.drops.publish(saved.id)).drop;
      toast(publish ? t('m.drops.published') : t('m.drops.form.saved'));
      router.push(`/drops/${saved.id}`);
    } catch (err) {
      const fields = (err as { fields?: Record<string, string> }).fields;
      if (fields) setErrors(fields);
      toast(err instanceof Error && !('status' in err) ? err.message : errorMessage(err));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }

  async function addProduct() {
    const cents = Math.round(Number(np.price.replace(',', '.')) * 100);
    if (!np.title.trim() || !Number.isFinite(cents) || cents < 0) return toast(t('m.drops.form.productIncomplete'));
    setNpBusy(true);
    try {
      const { product } = await api.shop.create({ kind: 'product', title: np.title.trim(), priceCents: cents, currency: np.currency });
      setPicks((cur) => (cur.length >= DROP_MAX_ITEMS ? cur : [...cur, { productId: product.id, quantity: '', perBuyerLimit: '' }]));
      setNp({ title: '', price: '', currency: np.currency });
      loadShop();
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setNpBusy(false);
    }
  }

  const coverShown = preview ?? (removeCover ? null : (drop?.coverUrl ?? null));

  return (
    <form
      className="stack drop-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save(false);
      }}
    >
      <TextField
        label={t('m.drops.form.name')}
        value={title}
        maxLength={DROP_TITLE_MAX}
        onChange={(e) => setTitle(e.currentTarget.value)}
        error={errors.title}
        required
      />
      <TextField
        label={t('m.drops.form.description')}
        multiline
        rows={3}
        value={description}
        maxLength={DROP_DESCRIPTION_MAX}
        onChange={(e) => setDescription(e.currentTarget.value)}
        hint={`${description.length}/${DROP_DESCRIPTION_MAX}`}
      />

      <fieldset className="drop-form__group">
        <legend>{t('m.drops.form.cover')}</legend>
        {coverShown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="drop-cover drop-cover--wide" src={coverShown} alt={coverAlt || t('m.drops.coverAlt', { title: title || '…' })} />
        ) : null}
        <Button variant="secondary" icon="image" onClick={() => fileRef.current?.click()}>
          {coverShown ? t('m.drops.form.changeCover') : t('m.drops.form.addCover')}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={IMAGE_ACCEPT}
          hidden
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) {
              setFile(f);
              setRemoveCover(false);
            }
            e.currentTarget.value = '';
          }}
        />
        {coverShown ? (
          <>
            <TextField label={t('m.drops.form.coverAlt')} value={coverAlt} maxLength={300} onChange={(e) => setCoverAlt(e.currentTarget.value)} />
            <Button
              variant="ghost"
              onClick={() => {
                setFile(null);
                setRemoveCover(true);
              }}
            >
              {t('m.drops.form.removeCover')}
            </Button>
          </>
        ) : null}
      </fieldset>

      <fieldset className="drop-form__group">
        <legend>{t('m.drops.form.when')}</legend>
        <TextField
          label={t('m.drops.form.starts')}
          type="datetime-local"
          value={starts}
          onChange={(e) => setStarts(e.currentTarget.value)}
          error={errors.startsAt}
          required
        />
        <TextField
          label={t('m.drops.form.ends')}
          type="datetime-local"
          value={ends}
          onChange={(e) => setEnds(e.currentTarget.value)}
          error={errors.endsAt}
          hint={ends ? undefined : t('m.drops.form.noEnd')}
        />
        {ends ? (
          <Button variant="ghost" onClick={() => setEnds('')}>
            {t('m.drops.form.clearEnd')}
          </Button>
        ) : null}
        <p className="muted" style={{ margin: 0 }}>
          {t('m.drops.form.timeNote', { zone })}{' '}
          {starts && !Number.isNaN(new Date(starts).getTime()) ? opensText(t, locale, new Date(starts).toISOString()) : ''}
        </p>
      </fieldset>

      <fieldset className="drop-form__group" aria-describedby="drop-products-hint">
        <legend>{t('m.drops.form.products')}</legend>
        <p id="drop-products-hint" className="muted" style={{ margin: 0 }}>
          {t('m.drops.form.productsHint')}
        </p>
        {errors.items ? (
          <Alert tone="danger" className="drop-form__error">
            {errors.items}
          </Alert>
        ) : null}
        {shop === null ? null : !shop.length ? <p className="muted">{t('m.drops.form.noProducts')}</p> : null}
        <ul className="drop-form__products">
          {(shop ?? []).map((p) => {
            const pick = picked(p.id);
            return (
              <li key={p.id} className="drop-form__product">
                <label className="yp-check">
                  <input
                    type="checkbox"
                    checked={!!pick}
                    disabled={!pick && picks.length >= DROP_MAX_ITEMS}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      setPicks((cur) => (on ? [...cur, { productId: p.id, quantity: '', perBuyerLimit: '' }] : cur.filter((x) => x.productId !== p.id)));
                    }}
                  />
                  <span>
                    <span dir="auto">{p.title}</span> <span className="muted">{formatMoney(p.priceCents, p.currency, locale)}</span>
                  </span>
                </label>
                {pick ? (
                  <div className="drop-form__numbers">
                    <TextField
                      label={t('m.drops.form.quantity')}
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={DROP_MAX_QUANTITY}
                      value={pick.quantity}
                      hint={t('m.drops.form.quantityHint')}
                      error={errors[`q:${p.id}`]}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        setPicks((cur) => cur.map((x) => (x.productId === p.id ? { ...x, quantity: v } : x)));
                      }}
                    />
                    {p.kind === 'digital' ? (
                      <p className="muted" style={{ margin: 0 }}>
                        {t('m.drops.form.oneEach')}
                      </p>
                    ) : (
                      <TextField
                        label={t('m.drops.form.limit')}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={DROP_MAX_PER_BUYER}
                        value={pick.perBuyerLimit}
                        hint={t('m.drops.form.limitHint')}
                        error={errors[`l:${p.id}`]}
                        onChange={(e) => {
                          const v = e.currentTarget.value;
                          setPicks((cur) => cur.map((x) => (x.productId === p.id ? { ...x, perBuyerLimit: v } : x)));
                        }}
                      />
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <details className="drop-form__new">
          <summary>{t('m.drops.form.newProduct')}</summary>
          <div className="stack-sm">
            <TextField
              label={t('m.drops.form.productTitle')}
              value={np.title}
              maxLength={120}
              onChange={(e) => setNp({ ...np, title: e.currentTarget.value })}
            />
            <div className="row drop-form__price">
              <TextField
                label={t('m.drops.form.price')}
                inputMode="decimal"
                value={np.price}
                onChange={(e) => setNp({ ...np, price: e.currentTarget.value })}
              />
              <Select label={t('m.drops.form.currency')} value={np.currency} onChange={(e) => setNp({ ...np, currency: e.currentTarget.value })}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <Button variant="secondary" icon="plus" loading={npBusy} onClick={() => void addProduct()}>
              {t('m.drops.form.addProduct')}
            </Button>
          </div>
        </details>
      </fieldset>

      {stage ? (
        <p className="muted" role="status">
          {stage}
        </p>
      ) : null}
      <div className="row drop__actions">
        {!drop || drop.status === 'draft' ? (
          <>
            <Button type="button" variant="secondary" loading={busy === 'draft'} disabled={!!busy} onClick={() => void save(false)}>
              {t('m.drops.form.saveDraft')}
            </Button>
            <Button type="button" loading={busy === 'publish'} disabled={!!busy} onClick={() => void save(true)}>
              {t('m.drops.form.saveAndPublish')}
            </Button>
          </>
        ) : (
          <Button type="submit" loading={!!busy}>
            {t('m.drops.form.save')}
          </Button>
        )}
      </div>
    </form>
  );
}
