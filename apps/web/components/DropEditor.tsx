'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Select, TextField } from '@yapilapi/design-system';
import type { ShopItem } from '@yapilapi/api-client';
import {
  CURRENCIES,
  DROP_DESCRIPTION_MAX,
  DROP_MAX_ITEMS,
  DROP_MAX_PER_BUYER,
  DROP_MAX_QUANTITY,
  DROP_TITLE_MAX,
  dropScheduleProblem,
  formatMoney,
  IMAGE_ACCEPT,
  type Drop,
  type MessageKey,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { localInput } from '@/lib/schedule';
import { useSession } from '@/app/providers';
import { opensText } from './Drops';

// The seller's form for a drop. Only the new and edit pages load it (see Drops.tsx for the cards).

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
