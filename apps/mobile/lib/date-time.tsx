// A date and time picker built from plain React Native views (no native picker module): a month
// calendar, hour and minute steppers on the locale's clock, shortcut chips and a readable summary.
// The date math lives in packages/shared/src/date-picker.ts, where it is unit tested.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addMinutes,
  addMonths,
  clampToRange,
  dateKey,
  dayDisabled,
  dayPeriodNames,
  formatClock,
  inRange,
  monthDisabled,
  monthGrid,
  monthTitle,
  quickChoices,
  sameDay,
  startOfDay,
  summaryParts,
  to12Hour,
  uses12Hour,
  weekdayNames,
  weekStartFor,
  withDay,
  yearsInRange,
  type DayCell,
  type Limits,
} from '../../../packages/shared/src/date-picker';
import type { MessageKey } from '../../../packages/shared/src/i18n';
import { useT, type Translator } from './i18n';
import { radius, space } from './theme';
import { Button, Icon, useColors } from './ui';

export type PickerMode = 'date' | 'datetime';
/** A shortcut shown as a chip at the top of the sheet. Ones outside the limits are hidden. */
export interface DatePreset {
  id: string;
  label: string;
  at: Date;
}

const STEP = 5;

/** The clock and calendar facts for the app's language, worked out once per language. */
function useCalendarLocale() {
  const tr = useT();
  return useMemo(() => {
    const hour12 = uses12Hour(tr.locale);
    const weekStart = weekStartFor(tr.locale);
    return {
      tr,
      hour12,
      weekStart,
      periods: dayPeriodNames(tr.locale),
      narrow: weekdayNames(tr.locale, weekStart, 'narrow'),
      long: weekdayNames(tr.locale, weekStart, 'long'),
    };
  }, [tr]);
}

/**
 * "Tomorrow at 9:00", "Today at 8:30 PM", "Sat 4 Oct at 20:00", with the year when it isn't this
 * year. In `date` mode, just the day.
 */
export function whenText(d: Date, tr: Translator, mode: PickerMode = 'datetime', now = new Date(), hour12 = uses12Hour(tr.locale)): string {
  const { day, withYear } = summaryParts(d, now);
  const dateOnly = tr.date(d, { weekday: 'short', day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  if (mode === 'date') return day === 'today' ? tr.t('m.picker.today') : day === 'tomorrow' ? tr.t('m.picker.tomorrow') : dateOnly;
  const time = formatClock(tr.locale, d, hour12);
  if (day === 'today') return tr.t('m.picker.todayAt', { time });
  if (day === 'tomorrow') return tr.t('m.picker.tomorrowAt', { time });
  return tr.t('m.picker.dateAt', { date: dateOnly, time });
}

/** `whenText` for components, on the clock of the app's language. */
export function useWhenText() {
  const { tr, hour12 } = useCalendarLocale();
  return (d: Date, mode: PickerMode = 'datetime') => whenText(d, tr, mode, new Date(), hour12);
}

const QUICK_LABEL: Record<string, MessageKey> = { hour: 'm.picker.inHour', tonight: 'm.picker.tonight', morning: 'm.picker.tomorrowMorning' };

export interface DateTimeSheetProps {
  visible: boolean;
  title: string;
  /** Where the sheet opens; clamped into the limits. Without one it opens on the first time allowed. */
  value?: Date | null;
  min?: Date | null;
  max?: Date | null;
  /** `date` picks a day (at midnight, local time); `datetime` adds the time steppers. */
  mode?: PickerMode;
  /** Shortcut chips, such as the old presets of a screen. */
  presets?: DatePreset[];
  /** Add the In 1 hour, Tonight and Tomorrow morning chips. */
  quick?: boolean;
  /** A line under the calendar, such as the allowed window. */
  hint?: string;
  /** The confirm button's text for the chosen time; "Done" without it. */
  confirmLabel?: (at: Date) => string;
  onClose: () => void;
  onPick: (at: Date) => void;
}

/**
 * A bottom sheet to pick a day (and a time) within limits. Days outside them are dimmed and can't
 * be chosen; times are on a five-minute grid and stay inside the limits. Screen readers get each
 * day as a button with its full date, and the hour and minute as adjustable values (swipe up or
 * down). The grid, arrows and chips follow the reading direction; the clock itself stays in
 * hours-then-minutes order, as it is written in every language the app has.
 */
export function DateTimeSheet({ visible, title, value, min, max, mode = 'datetime', presets, quick, hint, confirmLabel, onClose, onPick }: DateTimeSheetProps) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const cal = useCalendarLocale();
  const { tr } = cal;
  const { t } = tr;
  const limits: Limits = { min: min ?? null, max: max ?? null };
  const minMs = min?.getTime();
  const maxMs = max?.getTime();

  const normalize = (d: Date) => (mode === 'date' ? startOfDay(d) : d);
  const fit = (d: Date) => {
    const out = clampToRange(normalize(d), limits, STEP);
    // In date mode a clamped time can land mid-day: take a midnight that is still allowed.
    if (mode === 'date' && out.getTime() !== startOfDay(out).getTime()) {
      const next = new Date(out.getFullYear(), out.getMonth(), out.getDate() + 1);
      if (inRange(next, limits)) return next;
      if (inRange(startOfDay(out), limits)) return startOfDay(out);
    }
    return out;
  };

  const [draft, setDraft] = useState<Date>(() => fit(value ?? new Date()));
  const [view, setView] = useState(() => ({ year: draft.getFullYear(), month: draft.getMonth() }));
  const [years, setYears] = useState(false);
  const [now, setNow] = useState(() => new Date());

  // Each time the sheet opens, start again from the value (or the first time allowed).
  const wasVisible = useRef(false);
  useEffect(() => {
    if (visible && !wasVisible.current) {
      const start = fit(value ?? new Date());
      setDraft(start);
      setView({ year: start.getFullYear(), month: start.getMonth() });
      setYears(false);
      setNow(new Date());
    }
    wasVisible.current = visible;
  }, [visible, value?.getTime(), minMs, maxMs, mode]);

  const chips = useMemo(() => {
    const all = [...(quick ? quickChoices(now, STEP).map((q) => ({ id: q.id, label: t(QUICK_LABEL[q.id]!), at: q.at })) : []), ...(presets ?? [])];
    return all.filter((p) => inRange(normalize(p.at), limits));
  }, [quick, presets, now, minMs, maxMs, mode, t]);

  const grid = useMemo(() => monthGrid(view.year, view.month, cal.weekStart), [view.year, view.month, cal.weekStart]);
  const prev = addMonths(view.year, view.month, -1);
  const next = addMonths(view.year, view.month, 1);
  const prevOff = monthDisabled(prev.year, prev.month, limits);
  const nextOff = monthDisabled(next.year, next.month, limits);
  const yearChoices = yearsInRange(limits, draft);
  const canJumpYears = !!min && !!max ? max.getTime() - min.getTime() > 366 * 86_400_000 : false;

  const pickDay = (cell: DayCell) => {
    const d = mode === 'date' ? fit(new Date(cell.year, cell.month, cell.day)) : withDay(draft, cell.year, cell.month, cell.day, limits, STEP);
    setDraft(d);
    if (!cell.inMonth) setView({ year: cell.year, month: cell.month });
  };
  const choose = (d: Date) => {
    const out = fit(d);
    setDraft(out);
    setView({ year: out.getFullYear(), month: out.getMonth() });
  };
  const summary = whenText(draft, tr, mode, now, cal.hour12);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.overlay, justifyContent: 'flex-end' }}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('m.common.close')} style={{ flex: 1 }} onPress={onClose} />
        <View
          accessibilityViewIsModal
          style={{
            backgroundColor: c.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            paddingTop: space[4],
            paddingBottom: Math.max(insets.bottom, space[4]),
            maxHeight: '92%',
          }}
        >
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }} contentContainerStyle={{ paddingHorizontal: space[4], gap: space[3] }}>
            <View style={{ gap: 2 }}>
              <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 17, fontWeight: '800' }}>
                {title}
              </Text>
              <Text accessibilityLiveRegion="polite" style={{ color: c.yapi, fontSize: 15, fontWeight: '700' }}>
                {summary}
              </Text>
            </View>

            {chips.length ? (
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t('m.picker.shortcuts')}
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}
              >
                {chips.map((p) => {
                  const on = mode === 'date' ? sameDay(p.at, draft) : Math.abs(p.at.getTime() - draft.getTime()) < 60_000;
                  return (
                    <Pressable
                      key={p.id}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={`${p.label}, ${whenText(normalize(p.at), tr, mode, now, cal.hour12)}`}
                      onPress={() => choose(p.at)}
                      style={{
                        height: 34,
                        paddingHorizontal: space[3],
                        borderRadius: radius.full,
                        borderWidth: 1,
                        borderColor: on ? c.yapi : c.line,
                        backgroundColor: on ? c.yapiSoft : c.surface,
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ color: c.ink, fontWeight: on ? '700' : '600', fontSize: 13 }}>{p.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {/* Month header: previous, the month (a year jump for long ranges), next. */}
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <ArrowButton icon="chevron-back" label={t('m.picker.prevMonth')} disabled={prevOff} onPress={() => setView(prev)} />
              <Pressable
                accessibilityRole={canJumpYears ? 'button' : 'header'}
                accessibilityLabel={monthTitle(tr.locale, view.year, view.month)}
                accessibilityHint={canJumpYears ? t('m.picker.pickYear') : undefined}
                accessibilityState={canJumpYears ? { expanded: years } : undefined}
                disabled={!canJumpYears}
                onPress={() => setYears((v) => !v)}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minHeight: 44 }}
              >
                <Text style={{ color: c.ink, fontSize: 16, fontWeight: '700' }}>{monthTitle(tr.locale, view.year, view.month)}</Text>
                {canJumpYears ? <Icon name={years ? 'chevron-up' : 'chevron-down'} size={16} color={c.inkMuted} /> : null}
              </Pressable>
              <ArrowButton icon="chevron-forward" label={t('m.picker.nextMonth')} disabled={nextOff} onPress={() => setView(next)} />
            </View>

            {years ? (
              <View
                accessibilityRole="radiogroup"
                accessibilityLabel={t('m.picker.pickYear')}
                style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}
              >
                {yearChoices.map((y) => {
                  const on = y === view.year;
                  return (
                    <Pressable
                      key={y}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={tr.date(new Date(y, 0, 1), { year: 'numeric' })}
                      onPress={() => {
                        // Stay on the same month if that year has it inside the limits, else the nearest one.
                        let month = view.month;
                        if (min && new Date(y, month + 1, 1) <= min) month = min.getMonth();
                        if (max && new Date(y, month, 1) > max) month = max.getMonth();
                        setView({ year: y, month });
                        setYears(false);
                      }}
                      style={{
                        width: 72,
                        height: 40,
                        borderRadius: radius.full,
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderWidth: 1,
                        borderColor: on ? c.yapi : c.line,
                        backgroundColor: on ? c.yapiSoft : c.surface,
                      }}
                    >
                      <Text style={{ color: c.ink, fontWeight: on ? '700' : '600' }}>{tr.date(new Date(y, 0, 1), { year: 'numeric' })}</Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              <View>
                {/* Column heads are for the eye; each day already says its weekday to screen readers. */}
                <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ flexDirection: 'row' }}>
                  {cal.narrow.map((w, i) => (
                    <Text key={i} style={{ flex: 1, textAlign: 'center', color: c.inkMuted, fontSize: 12, fontWeight: '700', paddingVertical: 4 }}>
                      {w}
                    </Text>
                  ))}
                </View>
                {grid.map((week) => (
                  <View key={week[0]!.key} style={{ flexDirection: 'row' }}>
                    {week.map((cell) => (
                      <DayButton
                        key={cell.key}
                        cell={cell}
                        tr={tr}
                        selected={cell.key === dateKey(draft)}
                        today={cell.key === dateKey(now)}
                        disabled={dayDisabled(cell.year, cell.month, cell.day, limits, mode)}
                        onPress={() => pickDay(cell)}
                      />
                    ))}
                  </View>
                ))}
              </View>
            )}

            {mode === 'datetime' ? <TimeSteppers value={draft} limits={limits} hour12={cal.hour12} periods={cal.periods} onChange={setDraft} /> : null}

            {hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}

            <View style={{ flexDirection: 'row', gap: space[2], paddingTop: space[1] }}>
              <Button label={t('common.cancel')} variant="ghost" onPress={onClose} />
              <Button
                label={confirmLabel ? confirmLabel(draft) : t('m.common.done')}
                style={{ flex: 1 }}
                onPress={() => {
                  // The limits may have moved while the sheet was open (a minimum of "5 minutes from now"):
                  // then show the first time still allowed instead of sending one the server would refuse.
                  const out = fit(draft);
                  if (out.getTime() !== draft.getTime()) return setDraft(out);
                  onPick(out);
                }}
              />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function ArrowButton({ icon, label, disabled, onPress }: { icon: 'chevron-back' | 'chevron-forward'; label: string; disabled: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.3 : pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} size={22} color={c.ink} directional />
    </Pressable>
  );
}

function DayButton({
  cell,
  tr,
  selected,
  today,
  disabled,
  onPress,
}: {
  cell: DayCell;
  tr: Translator;
  selected: boolean;
  today: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  const date = new Date(cell.year, cell.month, cell.day);
  const spoken = tr.date(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={today ? `${spoken}, ${tr.t('m.picker.today')}` : spoken}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{ flex: 1, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: selected ? c.yapi : 'transparent',
          borderWidth: today && !selected ? 1.5 : 0,
          borderColor: c.yapi,
          opacity: disabled ? 0.3 : 1,
        }}
      >
        <Text
          style={{
            color: selected ? c.onYapi : cell.inMonth ? c.ink : c.inkMuted,
            fontWeight: selected || today ? '800' : '500',
            fontSize: 15,
            fontVariant: ['tabular-nums'],
          }}
        >
          {tr.number(cell.day)}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * Hour and minute steppers (minutes in fives) and, on a 12-hour clock, AM and PM. Stepping past
 * midnight moves the day, and a step that would leave the limits is disabled.
 */
function TimeSteppers({
  value,
  limits,
  hour12,
  periods,
  onChange,
}: {
  value: Date;
  limits: Limits;
  hour12: boolean;
  periods: { am: string; pm: string };
  onChange: (d: Date) => void;
}) {
  const c = useColors();
  const tr = useT();
  const { t } = tr;
  const step = (minutes: number) => clampToRange(addMinutes(value, minutes), limits, STEP);
  const can = (minutes: number) => step(minutes).getTime() !== value.getTime();
  const time = formatClock(tr.locale, value, hour12);
  const { hour, pm } = to12Hour(value.getHours());
  const hourText = hour12 ? tr.number(hour) : tr.number(value.getHours(), { minimumIntegerDigits: 2 });
  const minuteText = tr.number(value.getMinutes(), { minimumIntegerDigits: 2 });
  const period = (wantPm: boolean) => {
    if (wantPm === pm) return;
    const d = step(wantPm ? 12 * 60 : -12 * 60);
    // Keep the day: switching AM and PM never crosses midnight here.
    if (d.getDate() === value.getDate() && d.getHours() >= 12 === wantPm) onChange(d);
  };
  const periodOk = (wantPm: boolean) => {
    if (wantPm === pm) return true;
    const d = step(wantPm ? 12 * 60 : -12 * 60);
    return d.getDate() === value.getDate() && d.getHours() >= 12 === wantPm && d.getTime() !== value.getTime();
  };

  return (
    <View style={{ gap: space[2] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.picker.time')}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], flexWrap: 'wrap' }}>
        {/* Hours then minutes, left to right, in every language. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[1], direction: 'ltr' }}>
          <Stepper
            label={t('m.picker.hour')}
            text={hourText}
            valueText={time}
            canUp={can(60)}
            canDown={can(-60)}
            onUp={() => onChange(step(60))}
            onDown={() => onChange(step(-60))}
          />
          <Text style={{ color: c.ink, fontSize: 24, fontWeight: '800' }}>:</Text>
          <Stepper
            label={t('m.picker.minute')}
            text={minuteText}
            valueText={time}
            canUp={can(STEP)}
            canDown={can(-STEP)}
            onUp={() => onChange(step(STEP))}
            onDown={() => onChange(step(-STEP))}
          />
        </View>
        {hour12 ? (
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={t('m.picker.period')}
            style={{ flexDirection: 'row', backgroundColor: c.surfaceSunken, borderRadius: radius.full, padding: 3, gap: 3 }}
          >
            {[false, true].map((isPm) => {
              const on = isPm === pm;
              const ok = periodOk(isPm);
              return (
                <Pressable
                  key={String(isPm)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, disabled: !ok }}
                  disabled={!ok}
                  onPress={() => period(isPm)}
                  style={{
                    minWidth: 48,
                    height: 36,
                    paddingHorizontal: space[2],
                    borderRadius: radius.full,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: on ? c.surface : 'transparent',
                    opacity: ok ? 1 : 0.4,
                  }}
                >
                  <Text style={{ color: on ? c.ink : c.inkMuted, fontWeight: on ? '700' : '600' }}>{isPm ? periods.pm : periods.am}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * − value +. For screen readers it's one adjustable element: its name ("Hour"), the whole time as
 * its value, and increment and decrement actions (swipe up and down on iOS, volume keys or the
 * actions menu on Android).
 */
function Stepper({
  label,
  text,
  valueText,
  canUp,
  canDown,
  onUp,
  onDown,
}: {
  label: string;
  text: string;
  valueText: string;
  canUp: boolean;
  canDown: boolean;
  onUp: () => void;
  onDown: () => void;
}) {
  const c = useColors();
  const btn = (icon: 'remove' | 'add', enabled: boolean, onPress: () => void) => (
    <Pressable
      importantForAccessibility="no"
      disabled={!enabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        width: 40,
        height: 40,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: c.surfaceSunken,
        opacity: !enabled ? 0.35 : pressed ? 0.6 : 1,
      })}
    >
      <Icon name={icon} size={20} color={c.ink} />
    </Pressable>
  );
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: valueText }}
      accessibilityActions={[
        { name: 'increment', label: '+' },
        { name: 'decrement', label: '−' },
      ]}
      onAccessibilityAction={(e) => {
        if (e.nativeEvent.actionName === 'increment' && canUp) onUp();
        if (e.nativeEvent.actionName === 'decrement' && canDown) onDown();
      }}
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[1] }}
    >
      {btn('remove', canDown, onDown)}
      <Text style={{ color: c.ink, fontSize: 24, fontWeight: '800', minWidth: 40, textAlign: 'center', fontVariant: ['tabular-nums'] }}>{text}</Text>
      {btn('add', canUp, onUp)}
    </View>
  );
}

export interface DateFieldProps extends Omit<DateTimeSheetProps, 'visible' | 'onClose' | 'onPick' | 'title' | 'value'> {
  label: string;
  value: Date | null;
  onChange: (at: Date) => void;
  /** The sheet's title; the label without it. */
  sheetTitle?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Where the sheet opens while nothing is chosen (a birth date opens years back, not on the earliest day allowed). */
  openAt?: Date | null;
  /** A line under the field (`hint` is the line in the sheet). */
  note?: string;
}

/** A field that shows the chosen date (or a placeholder) and opens the DateTimeSheet. */
export function DateField({ label, value, onChange, sheetTitle, placeholder, disabled, mode = 'datetime', openAt, note, ...sheet }: DateFieldProps) {
  const c = useColors();
  const { t } = useT();
  const when = useWhenText();
  const [open, setOpen] = useState(false);
  const shown = value ? when(value, mode) : (placeholder ?? t('m.picker.choose'));
  return (
    <View style={{ gap: space[1] }}>
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${shown}`}
        accessibilityHint={note ? `${note} ${t('m.picker.openHint')}` : t('m.picker.openHint')}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          minHeight: 44,
          borderWidth: 1,
          borderRadius: radius.md,
          borderColor: c.line,
          backgroundColor: c.surface,
          paddingHorizontal: space[3],
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[2],
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        })}
      >
        <Icon name={mode === 'date' ? 'calendar-outline' : 'time-outline'} size={18} color={c.inkMuted} />
        <Text style={{ flex: 1, color: value ? c.ink : c.inkMuted, fontSize: 15, fontWeight: value ? '600' : '400' }} numberOfLines={1}>
          {shown}
        </Text>
        <Icon name="chevron-down" size={16} color={c.inkMuted} />
      </Pressable>
      {note ? (
        <Text accessibilityElementsHidden importantForAccessibility="no" style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>
          {note}
        </Text>
      ) : null}
      <DateTimeSheet
        {...sheet}
        mode={mode}
        visible={open}
        title={sheetTitle ?? label}
        value={value ?? openAt}
        onClose={() => setOpen(false)}
        onPick={(at) => {
          setOpen(false);
          onChange(at);
        }}
      />
    </View>
  );
}
