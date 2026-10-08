import { useEffect, useState } from 'react';
import { AccessibilityInfo, Pressable, Text, View } from 'react-native';
import {
  ASK_EXPIRIES,
  ASK_EXPIRY_KEYS,
  ASK_TEXT_MAX,
  ASK_TOPICS,
  ASK_TOPIC_KEYS,
  askAreaLabel,
  askDefaultExpiry,
  type AskCityInfo,
  type AskExpiry,
  type AskHelperSettings,
  type AskTopic,
} from '../../../packages/shared/src/ask-city';
import type { MapBox } from '../../../packages/shared/src/city-map';
import { clockTime } from '../../../packages/shared/src/location';
import { noticeText } from '../../../packages/shared/src/server-text';
import { VOICE_MAX_MS } from '../../../packages/shared/src/voice';
import { client, errorMessage } from './api';
import { Chip, ChipRow } from './chips';
import { PlacePicker, type PlacePick } from './city-map';
import { useFlag } from './flags';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Button, Card, Field, Icon, Notice, Segmented, SwitchRow, useColors, userText } from './ui';
import { uploadVoice, VoiceRecorder } from './voice';

/**
 * Ask the city on the phone (docs/product/ask-the-city.md): what a question post shows above its
 * words, the form to ask people nearby (said with the Yap recorder or written), the topic chips,
 * and "Help answer questions near me". The screen is app/ask.tsx; the web has the same in
 * apps/web/components/AskCity.tsx.
 */

const timeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** "18:30", or "Thu 18:30" when it's more than a day away. */
function untilText(iso: string, locale: string): string {
  if (Date.parse(iso) - Date.now() < 20 * 3_600_000) return clockTime(iso, locale);
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return clockTime(iso, locale);
  }
}

/**
 * Above a question's words: "Question · Food · Yaba, Lagos", whether it still needs an answer (or
 * is closed, or open until when), how many answers and whether one helped, and, for safety
 * questions, a gentle note about emergency numbers.
 */
export function AskCityTag({ ask }: { ask: AskCityInfo }) {
  const c = useColors();
  const { t, tp, locale } = useT();
  const topic = t(ASK_TOPIC_KEYS[ask.topic]);
  const area = askAreaLabel(ask);
  const needs = ask.open && ask.answers === 0;
  const status = !ask.open
    ? t('askCity.closed')
    : needs
      ? t('askCity.needsAnswer')
      : ask.expiresAt
        ? t('askCity.openUntil', { time: untilText(ask.expiresAt, locale) })
        : null;
  const meta = [status, ask.answers > 0 ? tp('askCity.answers', ask.answers) : null, ask.helpful > 0 ? t('askCity.helpful') : null].filter(Boolean);
  return (
    <View style={{ gap: space[1] }}>
      <View
        accessible
        accessibilityLabel={[t('askCity.badge'), topic, area].join(', ')}
        style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 }}
      >
        <Icon name="help-circle" size={16} color={c.yapi} />
        <Text style={{ color: c.yapi, fontWeight: '800', fontSize: 13 }}>{t('askCity.badge')}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>·</Text>
        <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{topic}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>·</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 1 }}>
          <Icon name="location-outline" size={14} color={c.inkMuted} />
          <Text style={[{ color: c.inkMuted, fontSize: 13, flexShrink: 1 }, userText]} numberOfLines={1}>
            {area}
          </Text>
        </View>
      </View>
      {meta.length ? (
        <View accessible accessibilityLabel={meta.join(', ')} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space[2] }}>
          {status ? <Text style={{ color: needs ? c.yapi : c.inkMuted, fontWeight: needs ? '700' : '500', fontSize: 12 }}>{status}</Text> : null}
          {ask.answers > 0 ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{tp('askCity.answers', ask.answers)}</Text> : null}
          {ask.helpful > 0 ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
              <Icon name="checkmark-circle" size={14} color={c.yapi} />
              <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }}>{t('askCity.helpful')}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {ask.topic === 'safety' ? <SafetyNote /> : null}
    </View>
  );
}

/** Safety questions: in an emergency, call the emergency number first. */
function SafetyNote() {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ flexDirection: 'row', gap: space[2], backgroundColor: c.saffronSoft, borderRadius: radius.md, padding: space[2] }}>
      <Icon name="shield-checkmark-outline" size={16} color={c.ink} />
      <Text style={{ flex: 1, color: c.ink, fontSize: 13, lineHeight: 18 }}>{t('askCity.safetyNote')}</Text>
    </View>
  );
}

/** Topic chips: one choice (with All first when `all`, for filtering). */
export function TopicChips({ value, onChange, all }: { value: AskTopic | null; onChange: (t: AskTopic | null) => void; all?: boolean }) {
  const { t } = useT();
  return (
    <ChipRow scroll={all} radios label={t('askCity.topic')}>
      {all ? <Chip radio label={t('m.wander.all')} selected={value === null} onPress={() => onChange(null)} /> : null}
      {ASK_TOPICS.map((topic) => (
        <Chip key={topic} radio label={t(ASK_TOPIC_KEYS[topic])} selected={value === topic} onPress={() => onChange(topic)} />
      ))}
    </ChipRow>
  );
}

type Where = 'city' | 'place' | 'map';

/**
 * Ask a question: say it (a Yap, up to a minute) or write it, choose a topic, where it's about (a
 * city, a place, or the part of the map it was opened from: never where you are) and how long it's
 * open. `onAsked` gets what to tell the asker: that it's out, or why it's waiting for review.
 */
export function AskForm({ city, box, onAsked, onCancel }: { city: string | null; box: MapBox | null; onAsked: (note: string) => void; onCancel: () => void }) {
  const c = useColors();
  const { t } = useT();
  const voiceOn = useFlag('YAPS') !== false;
  const [mode, setMode] = useState<'say' | 'write'>(voiceOn ? 'say' : 'write');
  const [recording, setRecording] = useState<{ uri: string } | null>(null);
  const [body, setBody] = useState('');
  const [topic, setTopic] = useState<AskTopic | null>(null);
  const [where, setWhere] = useState<Where>(box ? 'map' : 'city');
  const [cityText, setCityText] = useState(city ?? '');
  const [place, setPlace] = useState<PlacePick | null>(null);
  const [expiry, setExpiry] = useState<AskExpiry | 'none'>('none');
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The city listed arrives after the form opens: it fills the field unless something was typed.
  useEffect(() => {
    if (city) setCityText((cur) => cur || city);
  }, [city]);
  // Yaps turned off while saying one: write it instead.
  useEffect(() => {
    if (!voiceOn && mode === 'say') setMode('write');
  }, [voiceOn, mode]);

  const pickTopic = (next: AskTopic | null) => {
    setTopic(next);
    // Traffic is about now: it closes after an hour unless you chose otherwise.
    if (next && !expiryTouched) setExpiry(askDefaultExpiry(next) ?? 'none');
  };

  const ready = !!topic && (mode === 'say' ? !!recording : body.trim().length > 0) && (where !== 'place' || !!place) && (where !== 'city' || !!cityText.trim());

  async function submit() {
    if (!topic || !ready) return;
    setBusy(true);
    setProblem(null);
    try {
      const api = await client();
      const voiceId = mode === 'say' && recording ? (await uploadVoice(recording.uri, 'yap')).id : undefined;
      const area = where === 'place' && place ? { placeId: place.id } : where === 'map' && box ? { box, ...(city ? { city } : {}) } : { city: cityText.trim() };
      const r = await api.askCity.ask({
        topic,
        body: body.trim(),
        ...(voiceId ? { voiceId } : {}),
        area,
        expires: expiry === 'none' ? null : expiry,
        timeZone: timeZone(),
      });
      onAsked(noticeText(r.moderation, t) ?? t('askCity.posted'));
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const label = (text: string) => <Text style={{ color: c.ink, fontWeight: '700', fontSize: 14 }}>{text}</Text>;

  return (
    <Card style={{ gap: space[3] }}>
      <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800', fontSize: 17 }}>
        {t('askCity.ask')}
      </Text>
      {voiceOn ? (
        <Segmented
          label={t('askCity.ask')}
          value={mode}
          onChange={setMode}
          options={[
            { id: 'say', label: t('askCity.say') },
            { id: 'write', label: t('askCity.write') },
          ]}
        />
      ) : null}
      {mode === 'say' ? (
        <>
          <VoiceRecorder maxMs={VOICE_MAX_MS} purpose="yap" busy={busy} onDone={(uri) => setRecording({ uri })} onCancel={() => setRecording(null)} />
          <Field label={t('voice.lineLabel')} value={body} onChangeText={setBody} maxLength={ASK_TEXT_MAX} />
        </>
      ) : (
        <Field
          label={t('askCity.ask')}
          value={body}
          onChangeText={setBody}
          placeholder={t('askCity.placeholder')}
          multiline
          maxLength={ASK_TEXT_MAX}
          style={{ minHeight: 88, textAlignVertical: 'top', paddingTop: 12 }}
        />
      )}

      <View style={{ gap: space[2] }}>
        {label(t('askCity.topic'))}
        <TopicChips value={topic} onChange={pickTopic} />
      </View>
      {topic === 'safety' ? <SafetyNote /> : null}

      <View style={{ gap: space[2] }}>
        {label(t('askCity.where'))}
        <ChipRow radios label={t('askCity.where')}>
          {box ? <Chip radio label={t('askCity.mapArea')} selected={where === 'map'} onPress={() => setWhere('map')} /> : null}
          <Chip radio label={t('place.edit.city')} selected={where === 'city'} onPress={() => setWhere('city')} />
          <Chip radio label={t('map.tagPlace')} selected={where === 'place'} onPress={() => setWhere('place')} />
        </ChipRow>
        {where === 'city' ? <Field label={t('place.edit.city')} value={cityText} onChangeText={setCityText} maxLength={60} autoCorrect={false} /> : null}
        {where === 'place' ? <PlacePicker value={place} onChange={setPlace} /> : null}
        <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('askCity.areaNote')}</Text>
      </View>

      <View style={{ gap: space[2] }}>
        {label(t('askCity.openFor'))}
        <ChipRow radios label={t('askCity.openFor')}>
          {(['none', ...ASK_EXPIRIES] as const).map((x) => (
            <Chip
              key={x}
              radio
              label={x === 'none' ? t('askCity.expiry.none') : t(ASK_EXPIRY_KEYS[x])}
              selected={expiry === x}
              onPress={() => {
                setExpiryTouched(true);
                setExpiry(x);
              }}
            />
          ))}
        </ChipRow>
      </View>

      {problem ? <Notice tone="danger">{problem}</Notice> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        <Button label={busy ? t('m.create.publishing') : t('askCity.ask')} icon="help-circle-outline" disabled={!ready || busy} onPress={() => submit()} />
        <Button label={t('common.cancel')} variant="ghost" disabled={busy} onPress={onCancel} />
      </View>
    </Card>
  );
}

/** A topic to hear about, of several: a checkbox chip, 36 tall with 4 of slop, so 44 to tap. */
function TopicCheck({ label, on, disabled, onPress }: { label: string; on: boolean; disabled?: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 36,
        paddingHorizontal: space[3],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: on ? c.yapi : c.line,
        backgroundColor: on ? c.yapiSoft : c.surface,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      {on ? <Icon name="checkmark" size={16} color={c.yapi} /> : null}
      <Text style={{ color: c.ink, fontWeight: on ? '700' : '600', fontSize: 14 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** "Help answer questions near me": off by default; at most 3 notifications a day, in the topics chosen. */
export function HelperCard() {
  const c = useColors();
  const { t } = useT();
  const [s, setS] = useState<AskHelperSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void client()
      .then((api) => api.askCity.settings())
      .then(
        (r) => live && setS(r.settings),
        () => {},
      );
    return () => {
      live = false;
    };
  }, []);
  if (!s) return null;
  const save = async (next: { on: boolean; topics?: AskTopic[] }) => {
    setBusy(true);
    setError(null);
    try {
      setS((await (await client()).askCity.setSettings(next)).settings);
    } catch (e) {
      setError(errorMessage(e));
      AccessibilityInfo.announceForAccessibility(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card style={{ gap: space[2] }}>
      {s.city ? (
        <>
          <SwitchRow
            label={t('askCity.helpers.title')}
            hint={t('askCity.helpers.hint', { city: s.city })}
            value={s.on}
            disabled={busy}
            onValueChange={(on) => void save({ on })}
          />
          {s.on ? (
            <View accessibilityLabel={t('askCity.topic')} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {ASK_TOPICS.map((topic) => {
                const on = s.topics.includes(topic);
                return (
                  <TopicCheck
                    key={topic}
                    label={t(ASK_TOPIC_KEYS[topic])}
                    on={on}
                    // At least one topic stays chosen: turn the switch off to hear about none.
                    disabled={busy || (on && s.topics.length === 1)}
                    onPress={() => void save({ on: true, topics: on ? s.topics.filter((x) => x !== topic) : [...s.topics, topic] })}
                  />
                );
              })}
            </View>
          ) : null}
        </>
      ) : (
        <>
          <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>
            {t('askCity.helpers.title')}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('askCity.noCity')}</Text>
        </>
      )}
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </Card>
  );
}
