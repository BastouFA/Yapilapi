'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Avatar, Button, Checkbox, EmptyState, Icon, Select, Skeleton, TextField } from '@yapilapi/design-system';
import {
  CURRENCIES,
  formatMoney,
  freeTonightUntil,
  PLAN_ANSWER_KEYS,
  PLAN_ANSWERS,
  PLAN_RULES,
  type FreeFriend,
  type FreeNow,
  type Plan,
  type PlanAnswer,
  type PlanCard,
  type PlanCreateInput,
  type PlanPlace,
  type PlanPlaceKind,
  type PublicUser,
  type SquadCard,
} from '@yapilapi/shared';
import { api, ApiError, errorMessage, fieldErrors } from '@/lib/api';
import { useRealtime, useSession } from '@/app/providers';

/**
 * Go out together (docs/product/go-out-together.md): "I'm free", plans with friends, answers
 * (I'm in, Maybe, Can't), the plan's own chat (with polls), and a cost split that only keeps
 * count. No money moves through YAPILAPI.
 */

/** "Fri 31 Oct, 20:30" in the reader's language. */
export function planWhen(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}
const clock = (iso: string, locale: string) => new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** A datetime-local field's value for a moment, in this browser's time zone. */
function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Where to open a plan from Wander: a place page, an event or a stash, with its name to show. */
export function planFromHref(kind: Exclude<PlanPlaceKind, 'text'>, id: string, name: string | null): string {
  return `/plans/new?${new URLSearchParams({ place: `${kind}:${id}`, ...(name ? { name } : {}) })}`;
}

function PlaceLine({ place }: { place: PlanPlace | null }) {
  const { t } = useSession();
  if (!place?.name && !place?.id) return null;
  const name = place.name || t(place.kind === 'stash' ? 'stash.untitled' : 'plans.form.where');
  const href = place.id ? (place.kind === 'event' ? `/events/${place.id}` : place.kind === 'stash' ? `/stash/${place.id}` : `/places/${place.id}`) : null;
  return (
    <span className="plan-place">
      <Icon name="map-pin" size={16} /> {href ? <Link href={href}>{name}</Link> : <bdi>{name}</bdi>}
    </span>
  );
}

// ── I'm free ───────────────────────────────────────────────────────────

/**
 * "Who's free": say you're free now or tonight (friends only, it ends by itself), and see the
 * friends who are, each a tap from a plan with them. On Wander and in Chats.
 */
export function FreeStrip() {
  const { t, locale, me, flags, toast } = useSession();
  const [mine, setMine] = useState<FreeNow | null>(null);
  const [friends, setFriends] = useState<FreeFriend[] | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const on = !!me && flags.GO_OUT !== false;
  useEffect(() => {
    if (!on) return;
    api.free.get().then(
      (r) => {
        setMine(r.mine);
        setFriends(r.friends);
      },
      () => setFriends([]),
    );
  }, [on]);
  if (!on) return null;

  async function say(until: Date) {
    setBusy(true);
    try {
      setMine((await api.free.set({ until: until.toISOString(), note: note.trim() || undefined })).free);
      setOpen(false);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    try {
      await api.free.stop();
      setMine(null);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="free-strip" aria-labelledby="free-strip">
      <div className="free-strip__head">
        <h2 id="free-strip" className="section-title">
          {t('free.title')}
        </h2>
        <Link href="/plans" className="yp-btn yp-btn--ghost yp-btn--sm">
          <Icon name="calendar" size={16} /> {t('plans.title')}
        </Link>
      </div>
      {mine ? (
        <div className="free-strip__mine">
          <span>
            <strong>{t('free.youUntil', { time: clock(mine.until, locale) })}</strong>
            {mine.note ? <span className="muted"> · {mine.note}</span> : null}
          </span>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => void stop()}>
            {t('free.stop')}
          </Button>
        </div>
      ) : open ? (
        <div className="free-strip__form stack-sm">
          <TextField
            label={t('free.note')}
            placeholder={t('free.notePlaceholder')}
            value={note}
            maxLength={PLAN_RULES.freeNoteMax}
            onChange={(e) => setNote(e.currentTarget.value)}
            hint={t('free.hint')}
          />
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Button size="sm" loading={busy} onClick={() => void say(new Date(Date.now() + PLAN_RULES.freeNowHours * 3_600_000))}>
              {t('free.now')}
            </Button>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void say(freeTonightUntil())}>
              {t('free.tonight')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button size="sm" variant="secondary" icon="hand" onClick={() => setOpen(true)} aria-describedby="free-strip-hint">
            {t('free.me')}
          </Button>
          <Link href="/plans/new" className="yp-btn yp-btn--primary yp-btn--sm">
            <Icon name="plus" size={16} /> {t('plans.make')}
          </Link>
          <span id="free-strip-hint" className="muted free-strip__hint">
            {t('free.hint')}
          </span>
        </div>
      )}
      {friends === null ? (
        <Skeleton height={56} />
      ) : friends.length ? (
        <ul className="free-strip__list">
          {friends.map((f) => (
            <li key={f.user.id}>
              <Link
                href={`/plans/new?${new URLSearchParams({ with: f.user.id })}`}
                className="free-chip"
                aria-label={`${t('free.planWith', { name: f.user.displayName })}. ${t('free.until', { time: clock(f.until, locale) })}${f.note ? `. ${f.note}` : ''}`}
              >
                <Avatar name={f.user.displayName} src={f.user.avatarUrl} size="sm" />
                <span className="free-chip__text">
                  <bdi className="free-chip__name">{f.user.displayName}</bdi>
                  <span className="free-chip__meta">{f.note || t('free.until', { time: clock(f.until, locale) })}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted free-strip__empty">{t('free.empty')}</p>
      )}
    </section>
  );
}

// ── Lists ──────────────────────────────────────────────────────────────

function PlanRow({ plan }: { plan: PlanCard }) {
  const { t, locale } = useSession();
  return (
    <Link href={`/plans/${plan.id}`} className="plan-row">
      <span className="plan-row__icon" aria-hidden="true">
        <Icon name="calendar" size={20} />
      </span>
      <span className="plan-row__text">
        <bdi className="plan-row__title">{plan.title}</bdi>
        <span className="plan-row__meta">
          {planWhen(plan.startsAt, locale)}
          {plan.place?.name ? ` · ${plan.place.name}` : ''}
        </span>
        <span className="plan-row__meta">
          {plan.status === 'cancelled'
            ? t('plans.cancelled')
            : `${t(PLAN_ANSWER_KEYS[plan.answer])} · ${t('plans.counts', { in: plan.counts.in, maybe: plan.counts.maybe, pending: plan.counts.pending })}`}
        </span>
      </span>
    </Link>
  );
}

/** The Plans page: who's free, your plans coming up, then earlier ones. */
export function PlansHome() {
  const { t } = useSession();
  const [lists, setLists] = useState<{ upcoming: PlanCard[]; past: PlanCard[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = () =>
    api.plans.list().then(
      (r) => {
        setLists(r);
        setProblem(null);
      },
      (e) => setProblem(errorMessage(e)),
    );
  useEffect(() => {
    void load();
  }, []);
  useRealtime((e) => {
    if (e.type === 'plan.changed') void load();
  });
  return (
    <div className="stack plans-page">
      <FreeStrip />
      {problem ? (
        <EmptyState title={problem} action={<Button onClick={() => void load()}>{t('m.common.retry')}</Button>} />
      ) : !lists ? (
        <Skeleton height={120} />
      ) : !lists.upcoming.length && !lists.past.length ? (
        <EmptyState
          title={t('plans.empty')}
          action={
            <Link href="/plans/new" className="yp-btn yp-btn--primary">
              {t('plans.make')}
            </Link>
          }
        />
      ) : (
        <>
          {lists.upcoming.length ? (
            <section className="stack-sm" aria-labelledby="plans-upcoming">
              <h2 id="plans-upcoming" className="section-title">
                {t('plans.upcoming')}
              </h2>
              <ul className="plan-list">
                {lists.upcoming.map((p) => (
                  <li key={p.id}>
                    <PlanRow plan={p} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {lists.past.length ? (
            <section className="stack-sm" aria-labelledby="plans-past">
              <h2 id="plans-past" className="section-title">
                {t('plans.past')}
              </h2>
              <ul className="plan-list">
                {lists.past.map((p) => (
                  <li key={p.id}>
                    <PlanRow plan={p} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── Making and changing a plan ─────────────────────────────────────────

/** Friends to invite, with a search (friends only; `planId`: those not in it yet). */
function FriendPicker({ planId, chosen, onToggle }: { planId?: string; chosen: string[]; onToggle: (u: PublicUser) => void }) {
  const { t } = useSession();
  const id = useId();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const req = useRef(0);
  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        api.plans.candidates({ planId, q: q.trim() || undefined }).then(
          (r) => n === req.current && setPeople(r.items),
          () => n === req.current && setPeople([]),
        ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, planId]);
  return (
    <fieldset className="stack-sm plan-friends">
      <legend className="yp-field__label">{t('plans.form.invite')}</legend>
      <label htmlFor={`${id}-q`} className="yp-visually-hidden">
        {t('m.collab.search')}
      </label>
      <input
        id={`${id}-q`}
        className="yp-input"
        type="search"
        autoComplete="off"
        placeholder={t('m.collab.search')}
        value={q}
        maxLength={60}
        onChange={(e) => setQ(e.currentTarget.value)}
      />
      {people === null ? (
        <Skeleton height={80} />
      ) : people.length ? (
        <ul className="close-friends__list">
          {people.map((u) => (
            <li key={u.id} className="close-friends__row">
              <label className="squad-pick">
                <input type="checkbox" checked={chosen.includes(u.id)} onChange={() => onToggle(u)} />
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                <span className="sound-row__text">
                  <bdi className="sound-row__title">{u.displayName}</bdi>
                  <span className="sound-row__meta">
                    <bdi>@{u.username}</bdi>
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted" role="status" style={{ margin: 0, fontSize: 14 }}>
          {q.trim() ? t('m.group.noMatch', { query: q.trim() }) : t('plans.noFriends')}
        </p>
      )}
    </fieldset>
  );
}

/** Squads you're in, to invite one. */
function useSquads(): SquadCard[] {
  const { flags } = useSession();
  const [squads, setSquads] = useState<SquadCard[]>([]);
  useEffect(() => {
    if (flags.SQUADS === false) return;
    api.squads.list().then(
      (r) => setSquads(r.items.filter((s) => s.role)),
      () => setSquads([]),
    );
  }, [flags.SQUADS]);
  return squads;
}

/**
 * A new plan, or changes to one (its maker): what, when, where (a place from Wander, or words),
 * details, and who to invite. From Wander the place comes in `?place=event:<id>&name=…`; from "Who's
 * free", the friend in `?with=<id>`.
 */
export function PlanForm({ plan, onSaved }: { plan?: Plan; onSaved?: (p: Plan) => void }) {
  const { t, toast } = useSession();
  const router = useRouter();
  const squads = useSquads();
  const params = useSearchParams();
  const linked = (() => {
    const [kind, id] = (params.get('place') ?? '').split(':');
    return kind && id && ['place', 'event', 'stash'].includes(kind) ? { kind: kind as Exclude<PlanPlaceKind, 'text'>, id, name: params.get('name') } : null;
  })();
  const [title, setTitle] = useState(plan?.title ?? params.get('title') ?? '');
  const [when, setWhen] = useState(() => localInput(plan ? new Date(plan.startsAt) : new Date(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000)));
  const [place, setPlace] = useState<{ kind: PlanPlaceKind; id?: string; name: string } | null>(
    plan?.place
      ? { kind: plan.place.kind, id: plan.place.id ?? undefined, name: plan.place.name ?? '' }
      : linked
        ? { ...linked, name: linked.name ?? '' }
        : null,
  );
  const [where, setWhere] = useState(plan?.place?.kind === 'text' ? (plan.place.name ?? '') : '');
  const [note, setNote] = useState(plan?.note ?? '');
  const [chosen, setChosen] = useState<string[]>(() => (params.get('with') ? [params.get('with')!] : []));
  const [squadId, setSquadId] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const startsAt = new Date(when);
    if (Number.isNaN(startsAt.getTime())) return setErrors({ startsAt: t('plans.form.when') });
    const wherePlace =
      place && place.kind !== 'text' ? { kind: place.kind, id: place.id } : where.trim() ? { kind: 'text' as const, name: where.trim() } : null;
    setBusy(true);
    setErrors({});
    try {
      if (plan) {
        const r = await api.plans.edit(plan.id, { title: title.trim(), startsAt: startsAt.toISOString(), place: wherePlace, note: note.trim() });
        onSaved?.(r.plan);
      } else {
        const body: PlanCreateInput = {
          title: title.trim(),
          startsAt: startsAt.toISOString(),
          place: wherePlace,
          note: note.trim() || undefined,
          userIds: chosen,
          squadId: squadId || undefined,
        };
        const r = await api.plans.create(body);
        router.push(`/plans/${r.plan.id}`);
      }
    } catch (err) {
      setErrors(fieldErrors(err) ?? {});
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack plan-form" onSubmit={(e) => void submit(e)}>
      <TextField
        label={t('plans.form.title')}
        placeholder={t('plans.form.titlePlaceholder')}
        value={title}
        maxLength={PLAN_RULES.titleMax}
        required
        error={errors.title}
        onChange={(e) => setTitle(e.currentTarget.value)}
      />
      <TextField
        label={t('plans.form.when')}
        type="datetime-local"
        value={when}
        required
        error={errors.startsAt}
        onChange={(e) => setWhen(e.currentTarget.value)}
      />
      {place && place.kind !== 'text' ? (
        <div className="plan-form__place">
          <span className="yp-field__label">{t('plans.form.where')}</span>
          <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <PlaceLine place={{ kind: place.kind, id: place.id ?? null, name: place.name || null }} />
            <Button size="sm" variant="ghost" onClick={() => setPlace(null)}>
              {t('plans.remove')}
            </Button>
          </div>
        </div>
      ) : (
        <TextField
          label={t('plans.form.where')}
          value={where}
          maxLength={PLAN_RULES.placeMax}
          error={errors['place']}
          onChange={(e) => setWhere(e.currentTarget.value)}
        />
      )}
      <TextField label={t('plans.form.note')} multiline rows={3} value={note} maxLength={PLAN_RULES.noteMax} onChange={(e) => setNote(e.currentTarget.value)} />
      {plan ? null : (
        <>
          <FriendPicker chosen={chosen} onToggle={(u) => setChosen((c) => (c.includes(u.id) ? c.filter((x) => x !== u.id) : [...c, u.id]))} />
          {squads.length ? (
            <Select label={t('plans.form.squad')} value={squadId} onChange={(e) => setSquadId(e.currentTarget.value)}>
              <option value="">{t('plans.form.noSquad')}</option>
              {squads.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          ) : null}
        </>
      )}
      <div>
        <Button type="submit" loading={busy} disabled={!title.trim()}>
          {plan ? t('plans.form.save') : t('plans.form.submit')}
        </Button>
      </div>
    </form>
  );
}

// ── One plan ───────────────────────────────────────────────────────────

/** I'm in, Maybe, Can't: three buttons, the chosen one pressed. */
function AnswerButtons({ plan, onPlan }: { plan: Plan; onPlan: (p: Plan) => void }) {
  const { t, toast } = useSession();
  const [busy, setBusy] = useState<PlanAnswer | null>(null);
  async function answer(a: PlanAnswer) {
    setBusy(a);
    try {
      onPlan((await api.plans.answer(plan.id, a)).plan);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="plan-answers" role="group" aria-label={t('plans.yourAnswer')}>
      {PLAN_ANSWERS.map((a) => (
        <button
          key={a}
          type="button"
          className={`plan-answer plan-answer--${a}`}
          aria-pressed={plan.viewer.answer === a}
          disabled={busy !== null}
          onClick={() => void answer(a)}
        >
          <Icon name={a === 'in' ? 'check' : a === 'maybe' ? 'help' : 'x'} size={18} /> {t(PLAN_ANSWER_KEYS[a])}
        </button>
      ))}
    </div>
  );
}

/** Cost split: what was paid, who owes whom, "Mark paid back". Says plainly that no money moves here. */
function Costs({ plan, onPlan }: { plan: Plan; onPlan: (p: Plan) => void }) {
  const { t, tp, locale, me, toast } = useSession();
  const costs = plan.costs!;
  const inPlan = plan.people.filter((p) => p.answer === 'in' || p.answer === 'maybe');
  const nameOf = (id: string) => (id === me?.id ? t('m.chat.you') : (plan.people.find((p) => p.user.id === id)?.user.displayName ?? t('push.someone')));
  const canAdd = plan.viewer.answer === 'in' || plan.viewer.answer === 'maybe';
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<string>(() => costs.expenses.at(-1)?.currency ?? (locale.startsWith('fr') ? 'XOF' : 'NGN'));
  const [paidBy, setPaidBy] = useState(me?.id ?? '');
  const [split, setSplit] = useState<string[]>(() => inPlan.map((p) => p.user.id));
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, f: () => Promise<{ plan: Plan }>) {
    setBusy(key);
    try {
      onPlan((await f()).plan);
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount.replace(',', '.')) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return toast(t('plans.costs.amount'));
    const ok = await run('add', () => api.plans.addExpense(plan.id, { title: title.trim(), amountCents: cents, currency, paidBy, splitWith: split }));
    if (ok) {
      setTitle('');
      setAmount('');
      setAdding(false);
    }
  }

  return (
    <section className="stack-sm plan-costs" aria-labelledby="plan-costs">
      <h2 id="plan-costs" className="section-title">
        {t('plans.costs.title')}
      </h2>
      <p className="plan-costs__note" role="note">
        <Icon name="info" size={16} /> {t('plans.costs.note')}
      </p>
      {costs.debts.length ? (
        <ul className="plan-costs__debts">
          {costs.debts.map((d) => (
            <li key={`${d.from}-${d.to}-${d.currency}`} className="plan-costs__debt">
              <span>{t('plans.costs.owes', { from: nameOf(d.from), to: nameOf(d.to), amount: formatMoney(d.amountCents, d.currency, locale) })}</span>
              {me && (me.id === d.from || me.id === d.to) ? (
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy === `pay-${d.from}-${d.to}`}
                  onClick={() => void run(`pay-${d.from}-${d.to}`, () => api.plans.paidBack(plan.id, d))}
                >
                  {t('plans.costs.markPaid')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : costs.expenses.length ? (
        <p className="muted">{t('plans.costs.settled')}</p>
      ) : null}
      {costs.expenses.length ? (
        <ul className="plan-costs__list">
          {costs.expenses.map((x) => (
            <li key={x.id} className="plan-costs__row">
              <span className="plan-costs__text">
                <bdi className="plan-costs__title">{x.title || t('plans.costs.title')}</bdi>
                <span className="muted">
                  {t('plans.costs.paid', { name: nameOf(x.paidBy), amount: formatMoney(x.amountCents, x.currency, locale) })} ·{' '}
                  {tp('plans.costs.split', x.shares.length)}
                </span>
              </span>
              {x.canRemove ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === `rm-${x.id}`}
                  onClick={() => void run(`rm-${x.id}`, () => api.plans.removeExpense(plan.id, x.id))}
                >
                  {t('plans.remove')}
                </Button>
              ) : null}
            </li>
          ))}
          {costs.settlements.map((s) => (
            <li key={s.id} className="plan-costs__row">
              <span className="muted">
                {t('plans.costs.paidBack', { from: nameOf(s.from), to: nameOf(s.to), amount: formatMoney(s.amountCents, s.currency, locale) })}
              </span>
              {s.canUndo ? (
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === `undo-${s.id}`}
                  onClick={() => void run(`undo-${s.id}`, () => api.plans.undoPaidBack(plan.id, s.id))}
                >
                  {t('plans.costs.undo')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{t('plans.costs.empty')}</p>
      )}
      {canAdd ? (
        adding ? (
          <form className="stack-sm plan-costs__form" onSubmit={(e) => void add(e)}>
            <TextField
              label={t('plans.costs.what')}
              value={title}
              required
              maxLength={PLAN_RULES.expenseTitleMax}
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
            <div className="plan-costs__amount">
              <TextField
                label={t('plans.costs.amount')}
                inputMode="decimal"
                value={amount}
                required
                onChange={(e) => setAmount(e.currentTarget.value.replace(/[^\d.,]/g, ''))}
              />
              <Select label={t('plans.costs.currency')} value={currency} onChange={(e) => setCurrency(e.currentTarget.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </div>
            <Select label={t('plans.costs.paidBy')} value={paidBy} onChange={(e) => setPaidBy(e.currentTarget.value)}>
              {inPlan.map((p) => (
                <option key={p.user.id} value={p.user.id}>
                  {nameOf(p.user.id)}
                </option>
              ))}
            </Select>
            <fieldset className="stack-sm">
              <legend className="yp-field__label">{t('plans.costs.splitWith')}</legend>
              {inPlan.map((p) => (
                <Checkbox
                  key={p.user.id}
                  label={nameOf(p.user.id)}
                  checked={split.includes(p.user.id)}
                  onChange={() => setSplit((s) => (s.includes(p.user.id) ? s.filter((x) => x !== p.user.id) : [...s, p.user.id]))}
                />
              ))}
            </fieldset>
            <div className="row">
              <Button type="submit" size="sm" loading={busy === 'add'} disabled={!title.trim() || !amount || !split.length}>
                {t('plans.costs.add')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                {t('common.cancel')}
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button size="sm" variant="secondary" icon="plus" onClick={() => setAdding(true)}>
              {t('plans.costs.add')}
            </Button>
          </div>
        )
      ) : null}
    </section>
  );
}

/** One plan, for the people in it: answers, who's coming, its chat, inviting more, editing, the cost split. */
export function PlanPage({ id }: { id: string }) {
  const { t, locale, toast } = useSession();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<{ text: string; gone: boolean } | null>(null);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () =>
    api.plans.get(id).then(
      (r) => {
        setPlan(r.plan);
        setProblem(null);
      },
      (e) => setProblem({ text: errorMessage(e), gone: e instanceof ApiError && e.status === 404 }),
    );
  useEffect(() => {
    void load();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime((e) => {
    if (e.type === 'plan.changed' && (e.data as { id?: string })?.id === id) void load();
  });

  if (problem)
    return (
      <EmptyState
        title={problem.text}
        action={
          problem.gone ? (
            <Link href="/plans" className="yp-btn yp-btn--secondary">
              {t('plans.title')}
            </Link>
          ) : (
            <Button onClick={() => void load()}>{t('m.common.retry')}</Button>
          )
        }
      />
    );
  if (!plan) return <Skeleton height={240} />;
  const on = plan.status === 'active';

  async function invite() {
    setBusy('invite');
    try {
      const r = await api.plans.invite(plan!.id, { userIds: chosen });
      setPlan(r.plan);
      setChosen([]);
      setInviting(false);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function cancel() {
    if (!confirm(t('plans.cancelConfirm'))) return;
    setBusy('cancel');
    try {
      setPlan((await api.plans.cancel(plan!.id)).plan);
    } catch (e) {
      toast(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack plan-page">
      <div className="yp-topbar">
        <h1 className="plan-page__title">
          <bdi>{plan.title}</bdi>
        </h1>
      </div>
      <div className="plan-page__facts">
        {!on ? <p className="plan-page__cancelled">{t('plans.cancelled')}</p> : null}
        <span className="plan-place">
          <Icon name="clock" size={16} /> <time dateTime={plan.startsAt}>{planWhen(plan.startsAt, locale)}</time>
        </span>
        <PlaceLine place={plan.place} />
        <span className="muted">
          {t('plans.by', { name: plan.maker.displayName })}
          {plan.squad ? ` · ${t('plans.with', { squad: plan.squad.name })}` : ''}
        </span>
        {plan.note ? <p className="plan-page__note">{plan.note}</p> : null}
      </div>

      {editing ? (
        <PlanForm
          plan={plan}
          onSaved={(p) => {
            setPlan(p);
            setEditing(false);
          }}
        />
      ) : null}

      {on && !plan.viewer.maker ? <AnswerButtons plan={plan} onPlan={setPlan} /> : null}

      {plan.conversationId ? (
        <div className="stack-sm">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <Link href={`/inbox/${plan.conversationId}`} className="yp-btn yp-btn--primary yp-btn--sm">
              <Icon name="message" size={16} /> {t('plans.chat')}
            </Link>
            {on ? (
              <Link href={`/inbox/${plan.conversationId}?poll=1`} className="yp-btn yp-btn--secondary yp-btn--sm">
                <Icon name="poll" size={16} /> {t('plans.poll')}
              </Link>
            ) : null}
          </div>
          <p className="muted plan-page__hint">{t('plans.chatNote')}</p>
        </div>
      ) : null}

      <section className="stack-sm" aria-labelledby="plan-people">
        <h2 id="plan-people" className="section-title">
          {t('plans.people')}
        </h2>
        <p className="muted plan-page__hint">{t('plans.counts', { in: plan.counts.in, maybe: plan.counts.maybe, pending: plan.counts.pending })}</p>
        <ul className="plan-people">
          {plan.people.map((p) => (
            <li key={p.user.id} className="plan-person">
              <Avatar name={p.user.displayName} src={p.user.avatarUrl} size="sm" />
              <bdi className="plan-person__name">{p.user.displayName}</bdi>
              <span className={`plan-person__answer plan-person__answer--${p.answer}`}>{t(PLAN_ANSWER_KEYS[p.answer])}</span>
            </li>
          ))}
        </ul>
        {plan.viewer.canInvite ? (
          inviting ? (
            <div className="stack-sm">
              <FriendPicker
                planId={plan.id}
                chosen={chosen}
                onToggle={(u) => setChosen((c) => (c.includes(u.id) ? c.filter((x) => x !== u.id) : [...c, u.id]))}
              />
              <div className="row">
                <Button size="sm" loading={busy === 'invite'} disabled={!chosen.length} onClick={() => void invite()}>
                  {t('plans.invite')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setInviting(false)}>
                  {t('common.cancel')}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button size="sm" variant="secondary" icon="user-plus" onClick={() => setInviting(true)}>
                {t('plans.inviteMore')}
              </Button>
            </div>
          )
        ) : null}
      </section>

      {plan.costs ? <Costs plan={plan} onPlan={setPlan} /> : null}

      {plan.viewer.maker && on && !editing ? (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <Button variant="secondary" icon="edit" onClick={() => setEditing(true)}>
            {t('plans.edit')}
          </Button>
          <Button variant="danger" loading={busy === 'cancel'} onClick={() => void cancel()}>
            {t('plans.cancel')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The plan's card at the top of its chat: what, when, where and your answer, a tap from the plan. */
export function PlanChatCard({ planId }: { planId: string }) {
  const { t, locale } = useSession();
  const [plan, setPlan] = useState<Plan | null>(null);
  const load = () =>
    api.plans.get(planId).then(
      (r) => setPlan(r.plan),
      () => setPlan(null),
    );
  useEffect(() => {
    void load();
  }, [planId]); // eslint-disable-line react-hooks/exhaustive-deps
  useRealtime((e) => {
    if (e.type === 'plan.changed' && (e.data as { id?: string })?.id === planId) void load();
  });
  if (!plan) return null;
  return (
    <Link href={`/plans/${plan.id}`} className="plan-chat-card">
      <Icon name="calendar" size={18} />
      <span className="plan-chat-card__text">
        <bdi className="plan-chat-card__title">{t('plans.chatCard', { title: plan.title })}</bdi>
        <span className="plan-chat-card__meta">
          {plan.status === 'cancelled' ? t('plans.cancelled') : planWhen(plan.startsAt, locale)}
          {plan.place?.name ? ` · ${plan.place.name}` : ''} ·{' '}
          {t('plans.counts', { in: plan.counts.in, maybe: plan.counts.maybe, pending: plan.counts.pending })}
        </span>
      </span>
      <Icon name="chevron-right" size={18} />
    </Link>
  );
}
