import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, View } from 'react-native';
import { CURRENCIES } from '../../../packages/shared/src/constants';
import { formatMoney } from '../../../packages/shared/src/i18n-core';
import {
  freeTonightUntil,
  PLAN_ANSWER_KEYS,
  PLAN_ANSWERS,
  PLAN_RULES,
  type FreeFriend,
  type FreeNow,
  type Plan,
  type PlanAnswer,
  type PlanCard,
  type PlanPlace,
  type PlanPlaceKind,
} from '../../../packages/shared/src/plans';
import type { SquadCard } from '../../../packages/shared/src/squads';
import type { PublicUser } from '../../../packages/shared/src/types';
import { ApiError } from '../../../packages/api-client/src/index';
import { client, errorMessage } from './api';
import { DateField, useWhenText } from './date-time';
import { useFlag } from './flags';
import { ChoiceField, FieldError } from './forms';
import { useT, type Translate } from './i18n';
import { useRealtime, useSession } from './session';
import { radius, space } from './theme';
import { Avatar, Button, Card, Field, Icon, Notice, Skeleton, useColors, userText, type IconName } from './ui';

/**
 * Go out together on the phone (docs/product/go-out-together.md): "I'm free", plans with friends,
 * answers (I'm in, Maybe, Can't), the plan's own chat (with polls), and a cost split that only keeps
 * count. No money moves through YAPILAPI. Screens: app/go/index.tsx, app/go/new.tsx, app/go/[id].tsx.
 */

/** A thing in Wander a plan can be around: a place page, an event or a stash. */
export type PlanTarget = { kind: Exclude<PlanPlaceKind, 'text'>; id: string };

/** Make a plan around a place, an event or a stash from Wander, with its name to show. */
export function goWith(target: PlanTarget, name: string | null) {
  router.push({ pathname: '/go/new', params: { place: `${target.kind}:${target.id}`, ...(name ? { name } : {}) } });
}

/** "20:30" in the app's language. */
export function useClock() {
  const { date } = useT();
  return (iso: string) => date(iso, { hour: 'numeric', minute: '2-digit' });
}

/** "3 in · 1 maybe · 2 invited" for a plan. */
export function useCountsText() {
  const { t } = useT();
  return (counts: Plan['counts']) => t('plans.counts', { in: counts.in, maybe: counts.maybe, pending: counts.pending });
}

/** Where a plan happens, a tap from the place, event or stash when it is one. */
export function PlaceLine({ place }: { place: PlanPlace | null }) {
  const c = useColors();
  const { t } = useT();
  if (!place?.name && !place?.id) return null;
  const name = place.name || t(place.kind === 'stash' ? 'stash.untitled' : 'plans.form.where');
  const open = place.id
    ? () =>
        router.push(
          place.kind === 'event'
            ? { pathname: '/event/[id]', params: { id: place.id! } }
            : place.kind === 'stash'
              ? { pathname: '/stash/[id]', params: { id: place.id! } }
              : { pathname: '/place/[id]', params: { id: place.id! } },
        )
    : undefined;
  const line = (
    <>
      <Icon name="location-outline" size={16} color={c.inkMuted} />
      <Text style={[{ flexShrink: 1, color: open ? c.yapi : c.ink, fontWeight: open ? '600' : '400' }, userText]} numberOfLines={2}>
        {name}
      </Text>
    </>
  );
  return open ? (
    <Pressable accessibilityRole="link" onPress={open} style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], minHeight: 44 }}>
      {line}
    </Pressable>
  ) : (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}>{line}</View>
  );
}

// ── I'm free ───────────────────────────────────────────────────────────

/**
 * "Who's free": say you're free now or tonight (friends only, it ends by itself), and see the
 * friends who are, each a tap from a plan with them. On Wander, in Chats and on the Plans screen
 * (`home`: there, without the way to the Plans screen).
 */
export function FreeStrip({ home }: { home?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const clock = useClock();
  const goOut = useFlag('GO_OUT') !== false;
  const on = !!me && goOut;
  const [mine, setMine] = useState<FreeNow | null>(null);
  const [friends, setFriends] = useState<FreeFriend[] | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!on) return;
    void client()
      .then((api) => api.free.get())
      .then(
        (r) => {
          setMine(r.mine);
          setFriends(r.friends);
        },
        () => setFriends([]),
      );
  }, [on]);
  if (!on) return null;

  async function say(until: Date) {
    setProblem(null);
    try {
      setMine((await (await client()).free.set({ until: until.toISOString(), note: note.trim() || undefined })).free);
      setOpen(false);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }
  async function stop() {
    setProblem(null);
    try {
      await (await client()).free.stop();
      setMine(null);
    } catch (e) {
      setProblem(errorMessage(e));
    }
  }

  return (
    <View style={{ gap: space[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space[2] }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: c.ink, fontSize: 17, fontWeight: '800' }}>
          {t('free.title')}
        </Text>
        {home ? null : <Button label={t('plans.title')} icon="calendar-outline" size="sm" variant="ghost" onPress={() => router.push('/go')} />}
      </View>
      {mine ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2] }}>
          <Text style={[{ flex: 1, minWidth: 160, color: c.ink }, userText]}>
            <Text style={{ fontWeight: '700' }}>{t('free.youUntil', { time: clock(mine.until) })}</Text>
            {mine.note ? <Text style={{ color: c.inkMuted }}> · {mine.note}</Text> : null}
          </Text>
          <Button label={t('free.stop')} size="sm" variant="ghost" onPress={stop} />
        </View>
      ) : open ? (
        <View style={{ gap: space[2] }}>
          <Field
            label={t('free.note')}
            placeholder={t('free.notePlaceholder')}
            value={note}
            maxLength={PLAN_RULES.freeNoteMax}
            onChangeText={setNote}
            hint={t('free.hint')}
          />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('free.now')} size="sm" onPress={() => say(new Date(Date.now() + PLAN_RULES.freeNowHours * 3_600_000))} />
            <Button label={t('free.tonight')} size="sm" variant="secondary" onPress={() => say(freeTonightUntil())} />
            <Button label={t('common.cancel')} size="sm" variant="ghost" onPress={() => setOpen(false)} />
          </View>
        </View>
      ) : (
        <View style={{ gap: space[1] }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
            <Button label={t('free.me')} icon="hand-left-outline" size="sm" variant="secondary" onPress={() => setOpen(true)} />
            <Button label={t('plans.make')} icon="add" size="sm" onPress={() => router.push('/go/new')} />
          </View>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('free.hint')}</Text>
        </View>
      )}
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {friends === null ? (
        <Skeleton height={56} radius={radius.md} />
      ) : friends.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2], paddingVertical: 2 }}>
          {friends.map((f) => (
            <Pressable
              key={f.user.id}
              accessibilityRole="button"
              accessibilityLabel={`${t('free.planWith', { name: f.user.displayName })}. ${t('free.until', { time: clock(f.until) })}${f.note ? `. ${f.note}` : ''}`}
              onPress={() => router.push({ pathname: '/go/new', params: { with: f.user.id } })}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space[2],
                minHeight: 56,
                maxWidth: 240,
                paddingHorizontal: space[3],
                borderRadius: radius.full,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: pressed ? c.surfaceSunken : c.surface,
              })}
            >
              <Avatar name={f.user.displayName} url={f.user.avatarUrl} size={36} />
              <View style={{ flexShrink: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                  {f.user.displayName}
                </Text>
                <Text style={[{ color: c.inkMuted, fontSize: 12 }, userText]} numberOfLines={1}>
                  {f.note || t('free.until', { time: clock(f.until) })}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <Text style={{ color: c.inkMuted, lineHeight: 20 }}>{t('free.empty')}</Text>
      )}
    </View>
  );
}

// ── Lists ──────────────────────────────────────────────────────────────

/** A plan in your list: what, when, where, and your answer with the counts (or that it's cancelled). */
export function PlanRow({ plan }: { plan: PlanCard }) {
  const c = useColors();
  const { t } = useT();
  const when = useWhenText();
  const counts = useCountsText();
  const meta = `${when(new Date(plan.startsAt))}${plan.place?.name ? ` · ${plan.place.name}` : ''}`;
  const status = plan.status === 'cancelled' ? t('plans.cancelled') : `${t(PLAN_ANSWER_KEYS[plan.answer])} · ${counts(plan.counts)}`;
  return (
    <Card onPress={() => router.push({ pathname: '/go/[id]', params: { id: plan.id } })} label={`${plan.title}, ${meta}, ${status}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
        <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="calendar-outline" size={22} color={c.yapi} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]} numberOfLines={1}>
            {plan.title}
          </Text>
          <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
            {meta}
          </Text>
          <Text style={{ color: plan.status === 'cancelled' ? c.danger : c.inkMuted, fontSize: 13 }} numberOfLines={1}>
            {status}
          </Text>
        </View>
        <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
      </View>
    </Card>
  );
}

// ── Making and changing a plan ─────────────────────────────────────────

/** Friends to invite, with a search (friends only; `planId`: those not in it yet); tap to choose. */
export function PlanPeoplePick({ planId, chosen, onToggle }: { planId?: string; chosen: string[]; onToggle: (u: PublicUser) => void }) {
  const c = useColors();
  const { t } = useT();
  const [q, setQ] = useState('');
  const [people, setPeople] = useState<PublicUser[] | null>(null);
  const req = useRef(0);
  useEffect(() => {
    const n = ++req.current;
    const timer = setTimeout(
      () =>
        void client()
          .then((api) => api.plans.candidates({ planId, q: q.trim() || undefined }))
          .then(
            (r) => n === req.current && setPeople(r.items),
            () => n === req.current && setPeople([]),
          ),
      q ? 150 : 0,
    );
    return () => clearTimeout(timer);
  }, [q, planId]);
  const max = PLAN_RULES.maxPeople - 1;
  return (
    <View style={{ gap: space[2] }}>
      <Field
        label={t('plans.form.invite')}
        placeholder={t('m.collab.search')}
        value={q}
        onChangeText={setQ}
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={60}
      />
      {people === null ? (
        <Skeleton height={48} />
      ) : people.length ? (
        people.map((u) => {
          const on = chosen.includes(u.id);
          const off = !on && chosen.length >= max;
          return (
            <Pressable
              key={u.id}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: off }}
              accessibilityLabel={`${u.displayName}, @${u.username}`}
              disabled={off}
              onPress={() => onToggle(u)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48, opacity: off ? 0.5 : 1 }}
            >
              <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={1}>
                  {u.displayName}
                </Text>
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
                  @{u.username}
                </Text>
              </View>
              <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
            </Pressable>
          );
        })
      ) : (
        <Text style={{ color: c.inkMuted, lineHeight: 20 }} accessibilityLiveRegion="polite">
          {q.trim() ? t('m.group.noMatch', { query: q.trim() }) : t('plans.noFriends')}
        </Text>
      )}
    </View>
  );
}

/** Squads you're in, to invite one. */
function useSquads(): SquadCard[] {
  const on = useFlag('SQUADS') !== false;
  const [squads, setSquads] = useState<SquadCard[]>([]);
  useEffect(() => {
    if (!on) return;
    void client()
      .then((api) => api.squads.list())
      .then(
        (r) => setSquads(r.items.filter((s) => s.role)),
        () => setSquads([]),
      );
  }, [on]);
  return squads;
}

/** The next quarter hour at least an hour from now: where a new plan's time starts. */
const soon = () => new Date(Math.ceil((Date.now() + 3_600_000) / 900_000) * 900_000);

/**
 * A new plan, or changes to one (its maker): what, when, where (a place from Wander, or words),
 * details, and who to invite. From Wander the place comes as `linked`; from "Who's free", the friend
 * in `withId`. A new plan opens once made; changes go to `onSaved`.
 */
export function PlanForm({
  plan,
  linked,
  withId,
  title: firstTitle,
  onSaved,
  onCancel,
}: {
  plan?: Plan;
  linked?: (PlanTarget & { name: string | null }) | null;
  withId?: string | null;
  title?: string | null;
  onSaved?: (p: Plan) => void;
  onCancel?: () => void;
}) {
  const c = useColors();
  const { t } = useT();
  const squads = useSquads();
  const now = new Date();
  const [title, setTitle] = useState(plan?.title ?? firstTitle ?? '');
  const [when, setWhen] = useState<Date>(() => (plan ? new Date(plan.startsAt) : soon()));
  const [place, setPlace] = useState<{ kind: PlanPlaceKind; id?: string; name: string } | null>(() =>
    plan?.place
      ? { kind: plan.place.kind, id: plan.place.id ?? undefined, name: plan.place.name ?? '' }
      : linked
        ? { ...linked, name: linked.name ?? '' }
        : null,
  );
  const [where, setWhere] = useState(plan?.place?.kind === 'text' ? (plan.place.name ?? '') : '');
  const [note, setNote] = useState(plan?.note ?? '');
  const [chosen, setChosen] = useState<string[]>(() => (withId ? [withId] : []));
  const [squadId, setSquadId] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});

  async function submit() {
    // A linked place the maker can't see any more (no id) is left as it is when the plan changes.
    const unseen = !!place && place.kind !== 'text' && !place.id;
    const wherePlace =
      place && place.kind !== 'text' && place.id ? { kind: place.kind, id: place.id } : where.trim() ? { kind: 'text' as const, name: where.trim() } : null;
    setBusy(true);
    setProblem(null);
    setFields({});
    try {
      const api = await client();
      if (plan) {
        const r = await api.plans.edit(plan.id, {
          title: title.trim(),
          startsAt: when.toISOString(),
          ...(unseen ? {} : { place: wherePlace }),
          note: note.trim(),
        });
        onSaved?.(r.plan);
      } else {
        const r = await api.plans.create({
          title: title.trim(),
          startsAt: when.toISOString(),
          place: wherePlace,
          note: note.trim() || undefined,
          userIds: chosen,
          squadId: squadId || undefined,
        });
        router.replace({ pathname: '/go/[id]', params: { id: r.plan.id } });
      }
    } catch (e) {
      if (e instanceof ApiError && e.fields) setFields(e.fields);
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: space[4] }}>
      <View style={{ gap: space[1] }}>
        <Field
          label={t('plans.form.title')}
          placeholder={t('plans.form.titlePlaceholder')}
          value={title}
          maxLength={PLAN_RULES.titleMax}
          onChangeText={setTitle}
        />
        <FieldError text={fields.title} />
      </View>
      <View style={{ gap: space[1] }}>
        <DateField
          label={t('plans.form.when')}
          value={when}
          onChange={setWhen}
          min={plan ? null : now}
          max={new Date(now.getTime() + PLAN_RULES.aheadDays * 86_400_000)}
          quick={!plan}
        />
        <FieldError text={fields.startsAt} />
      </View>
      {place && place.kind !== 'text' ? (
        <View style={{ gap: space[1] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('plans.form.where')}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2] }}>
            <View style={{ flexShrink: 1 }}>
              <PlaceLine place={{ kind: place.kind, id: place.id ?? null, name: place.name || null }} />
            </View>
            <Button label={t('plans.remove')} size="sm" variant="ghost" onPress={() => setPlace(null)} />
          </View>
        </View>
      ) : (
        <View style={{ gap: space[1] }}>
          <Field label={t('plans.form.where')} value={where} maxLength={PLAN_RULES.placeMax} onChangeText={setWhere} />
          <FieldError text={fields.place} />
        </View>
      )}
      <Field
        label={t('plans.form.note')}
        value={note}
        maxLength={PLAN_RULES.noteMax}
        onChangeText={setNote}
        multiline
        style={{ minHeight: 88, textAlignVertical: 'top' }}
      />
      {plan ? null : (
        <>
          <PlanPeoplePick chosen={chosen} onToggle={(u) => setChosen((cur) => (cur.includes(u.id) ? cur.filter((x) => x !== u.id) : [...cur, u.id]))} />
          {squads.length ? (
            <ChoiceField
              label={t('plans.form.squad')}
              value={squadId}
              options={[{ id: '', label: t('plans.form.noSquad') }, ...squads.map((s) => ({ id: s.id, label: s.name }))]}
              onChange={setSquadId}
            />
          ) : null}
        </>
      )}
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Button
          label={busy ? t('m.common.saving') : plan ? t('plans.form.save') : t('plans.form.submit')}
          icon={plan ? undefined : 'calendar-outline'}
          disabled={busy || !title.trim()}
          onPress={submit}
        />
        {onCancel ? <Button label={t('common.cancel')} variant="ghost" onPress={onCancel} /> : null}
      </View>
    </View>
  );
}

// ── One plan ───────────────────────────────────────────────────────────

const ANSWER_ICONS: Record<PlanAnswer, IconName> = { in: 'checkmark', maybe: 'help', cant: 'close' };

/** I'm in, Maybe, Can't: three 44pt buttons, the chosen one selected. */
export function AnswerButtons({ plan, onPlan, onError }: { plan: Plan; onPlan: (p: Plan) => void; onError: (message: string) => void }) {
  const c = useColors();
  const { t } = useT();
  const [busy, setBusy] = useState<PlanAnswer | null>(null);
  async function answer(a: PlanAnswer) {
    setBusy(a);
    try {
      onPlan((await (await client()).plans.answer(plan.id, a)).plan);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('plans.yourAnswer')}</Text>
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        {PLAN_ANSWERS.map((a) => {
          const on = plan.viewer.answer === a;
          return (
            <Pressable
              key={a}
              accessibilityRole="button"
              accessibilityState={{ selected: on, disabled: busy !== null, busy: busy === a }}
              accessibilityLabel={t(PLAN_ANSWER_KEYS[a])}
              disabled={busy !== null}
              onPress={() => void answer(a)}
              style={({ pressed }) => ({
                flex: 1,
                minHeight: 48,
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'center',
                gap: space[1],
                paddingHorizontal: space[2],
                borderRadius: radius.full,
                borderWidth: on ? 2 : 1,
                borderColor: on ? c.yapi : c.line,
                backgroundColor: on ? c.yapiSoft : c.surface,
                opacity: busy !== null && busy !== a ? 0.6 : pressed ? 0.85 : 1,
              })}
            >
              <Icon name={ANSWER_ICONS[a]} size={18} color={on ? c.yapi : c.ink} />
              <Text maxFontSizeMultiplier={2} numberOfLines={1} style={{ flexShrink: 1, color: c.ink, fontWeight: on ? '800' : '600' }}>
                {t(PLAN_ANSWER_KEYS[a])}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Cost split: what was paid, who owes whom, "Mark paid back". Says plainly that no money moves here. */
export function Costs({ plan, onPlan }: { plan: Plan; onPlan: (p: Plan) => void }) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const { me } = useSession();
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
  const [problem, setProblem] = useState<string | null>(null);

  async function run(work: () => Promise<{ plan: Plan }>) {
    setProblem(null);
    try {
      onPlan((await work()).plan);
      return true;
    } catch (e) {
      setProblem(errorMessage(e));
      return false;
    }
  }
  async function add() {
    const cents = Math.round(Number(amount.replace(',', '.')) * 100);
    if (!Number.isFinite(cents) || cents <= 0) return setProblem(t('plans.costs.amount'));
    const ok = await run(async () =>
      (await client()).plans.addExpense(plan.id, { title: title.trim(), amountCents: cents, currency, paidBy, splitWith: split }),
    );
    if (ok) {
      setTitle('');
      setAmount('');
      setAdding(false);
    }
  }

  const row = { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space[2], minHeight: 44 } as const;
  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '700', fontSize: 16 }}>
        {t('plans.costs.title')}
      </Text>
      <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-start' }}>
        <Icon name="information-circle-outline" size={18} color={c.inkMuted} />
        <Text style={{ flex: 1, color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('plans.costs.note')}</Text>
      </View>
      {costs.debts.length ? (
        costs.debts.map((d) => (
          <View key={`${d.from}-${d.to}-${d.currency}`} style={row}>
            <Text style={[{ flex: 1, minWidth: 160, color: c.ink, fontWeight: '600' }, userText]}>
              {t('plans.costs.owes', { from: nameOf(d.from), to: nameOf(d.to), amount: formatMoney(d.amountCents, d.currency, locale) })}
            </Text>
            {me && (me.id === d.from || me.id === d.to) ? (
              <Button
                label={t('plans.costs.markPaid')}
                size="sm"
                variant="secondary"
                onPress={() => run(async () => (await client()).plans.paidBack(plan.id, d))}
              />
            ) : null}
          </View>
        ))
      ) : costs.expenses.length ? (
        <Text style={{ color: c.inkMuted }}>{t('plans.costs.settled')}</Text>
      ) : null}
      {costs.expenses.length ? (
        <View style={{ gap: space[1] }}>
          {costs.expenses.map((x) => (
            <View key={x.id} style={row}>
              <View style={{ flex: 1, minWidth: 160 }}>
                <Text style={[{ color: c.ink, fontWeight: '600' }, userText]} numberOfLines={2}>
                  {x.title || t('plans.costs.title')}
                </Text>
                <Text style={[{ color: c.inkMuted, fontSize: 13 }, userText]}>
                  {t('plans.costs.paid', { name: nameOf(x.paidBy), amount: formatMoney(x.amountCents, x.currency, locale) })} ·{' '}
                  {tp('plans.costs.split', x.shares.length)}
                </Text>
              </View>
              {x.canRemove ? (
                <Button
                  label={t('plans.remove')}
                  accessibilityLabel={`${t('plans.remove')}: ${x.title || t('plans.costs.title')}`}
                  size="sm"
                  variant="ghost"
                  onPress={() => run(async () => (await client()).plans.removeExpense(plan.id, x.id))}
                />
              ) : null}
            </View>
          ))}
          {costs.settlements.map((s) => {
            const text = t('plans.costs.paidBack', { from: nameOf(s.from), to: nameOf(s.to), amount: formatMoney(s.amountCents, s.currency, locale) });
            return (
              <View key={s.id} style={row}>
                <Text style={[{ flex: 1, minWidth: 160, color: c.inkMuted }, userText]}>{text}</Text>
                {s.canUndo ? (
                  <Button
                    label={t('plans.costs.undo')}
                    accessibilityLabel={`${t('plans.costs.undo')}: ${text}`}
                    size="sm"
                    variant="ghost"
                    onPress={() => run(async () => (await client()).plans.undoPaidBack(plan.id, s.id))}
                  />
                ) : null}
              </View>
            );
          })}
        </View>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('plans.costs.empty')}</Text>
      )}
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      {canAdd ? (
        adding ? (
          <View style={{ gap: space[3] }}>
            <Field label={t('plans.costs.what')} value={title} maxLength={PLAN_RULES.expenseTitleMax} onChangeText={setTitle} />
            <Field label={t('plans.costs.amount')} value={amount} keyboardType="decimal-pad" onChangeText={(v) => setAmount(v.replace(/[^\d.,]/g, ''))} />
            <ChoiceField
              label={t('plans.costs.currency')}
              value={currency}
              options={CURRENCIES.map((x) => ({ id: x as string, label: x }))}
              onChange={setCurrency}
            />
            <ChoiceField
              label={t('plans.costs.paidBy')}
              value={paidBy}
              options={inPlan.map((p) => ({ id: p.user.id, label: nameOf(p.user.id) }))}
              onChange={setPaidBy}
            />
            <View style={{ gap: space[1] }}>
              <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('plans.costs.splitWith')}</Text>
              {inPlan.map((p) => {
                const on = split.includes(p.user.id);
                return (
                  <Pressable
                    key={p.user.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={nameOf(p.user.id)}
                    onPress={() => setSplit((cur) => (cur.includes(p.user.id) ? cur.filter((x) => x !== p.user.id) : [...cur, p.user.id]))}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
                  >
                    <Icon name={on ? 'checkbox' : 'square-outline'} size={24} color={on ? c.yapi : c.inkMuted} />
                    <Text style={[{ flex: 1, color: c.ink }, userText]} numberOfLines={1}>
                      {nameOf(p.user.id)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              <Button label={t('plans.costs.add')} size="sm" disabled={!title.trim() || !amount || !split.length || !paidBy} onPress={add} />
              <Button label={t('common.cancel')} size="sm" variant="ghost" onPress={() => setAdding(false)} />
            </View>
          </View>
        ) : (
          <Button label={t('plans.costs.add')} icon="add" size="sm" variant="secondary" onPress={() => setAdding(true)} style={{ alignSelf: 'flex-start' }} />
        )
      ) : null}
    </Card>
  );
}

/** One plan, loaded and kept fresh: reloads when it changes (answers, edits, costs) for anyone in it. */
export function usePlan(id: string | undefined) {
  const [plan, setPlan] = useState<Plan | null | undefined>(undefined);
  const [problem, setProblem] = useState<{ text: string; gone: boolean } | null>(null);
  const load = useCallback(async () => {
    if (!id) return;
    try {
      setPlan((await (await client()).plans.get(id)).plan);
      setProblem(null);
    } catch (e) {
      setProblem({ text: errorMessage(e), gone: e instanceof ApiError && e.status === 404 });
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  useRealtime((e) => {
    if (e.type === 'plan.changed' && e.data?.id === id) void load();
  });
  return { plan, setPlan, problem, load };
}

/** The plan's card at the top of its chat: what, when, where and the counts, a tap from the plan. */
export function PlanChatCard({ planId }: { planId: string }) {
  const c = useColors();
  const { t } = useT();
  const when = useWhenText();
  const counts = useCountsText();
  const { plan } = usePlan(planId);
  if (!plan) return null;
  const title = t('plans.chatCard', { title: plan.title });
  const meta = `${plan.status === 'cancelled' ? t('plans.cancelled') : when(new Date(plan.startsAt))}${plan.place?.name ? ` · ${plan.place.name}` : ''} · ${counts(plan.counts)}`;
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`${title}, ${meta}`}
      onPress={() => router.push({ pathname: '/go/[id]', params: { id: plan.id } })}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 52,
        marginHorizontal: space[3],
        marginTop: space[2],
        paddingHorizontal: space[3],
        paddingVertical: space[2],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.surfaceSunken : c.surface,
        borderWidth: 1,
        borderColor: c.line,
      })}
    >
      <Icon name="calendar-outline" size={20} color={c.yapi} />
      <View style={{ flex: 1 }}>
        <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[{ color: plan.status === 'cancelled' ? c.danger : c.inkMuted, fontSize: 13 }, userText]} numberOfLines={1}>
          {meta}
        </Text>
      </View>
      <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
    </Pressable>
  );
}

/** Cancel a plan, after asking (everyone invited is told). */
export function confirmCancel(t: Translate, cancel: () => void) {
  Alert.alert(t('plans.cancel'), t('plans.cancelConfirm'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('plans.cancel'), style: 'destructive', onPress: cancel },
  ]);
}
