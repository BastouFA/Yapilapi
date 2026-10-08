'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Card, Select, Switch, TextField } from '@yapilapi/design-system';
import {
  ASK_EXPIRIES,
  ASK_EXPIRY_KEYS,
  ASK_TEXT_MAX,
  ASK_TOPICS,
  ASK_TOPIC_KEYS,
  VOICE_MAX_MS,
  askDefaultExpiry,
  noticeText,
  type AskExpiry,
  type AskHelperSettings,
  type AskTopic,
  type MapBox,
  type Post,
} from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { PlacePicker, type TaggedPlace } from '@/components/CityMap';
import { uploadVoice, voiceError, YapRecorder, type Recording } from '@/components/YapRecorder';
import { useSession } from '@/app/providers';

/**
 * Ask the city on the web (docs/product/ask-the-city.md): the form to ask people nearby, and
 * "Help answer questions near me". The page is app/(app)/ask/page.tsx.
 */

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

/** Topic chips: one choice, each a 44px toggle. */
export function TopicChips({ value, onChange, label, all }: { value: AskTopic | null; onChange: (t: AskTopic | null) => void; label: string; all?: boolean }) {
  const { t } = useSession();
  return (
    <div className="askcity-chips" role="group" aria-label={label}>
      {all ? (
        <button type="button" className="askcity-chip" aria-pressed={value === null} onClick={() => onChange(null)}>
          {t('m.wander.all')}
        </button>
      ) : null}
      {ASK_TOPICS.map((topic) => (
        <button key={topic} type="button" className="askcity-chip" aria-pressed={value === topic} onClick={() => onChange(topic)}>
          {t(ASK_TOPIC_KEYS[topic])}
        </button>
      ))}
    </div>
  );
}

type Where = 'city' | 'place' | 'map';

/**
 * Ask a question: say it (a Yap) or write it, choose a topic, where it's about (your city, a place,
 * or the part of the map you came from: never where you are) and how long it's open.
 */
export function AskForm({ city, box, onAsked, onCancel }: { city: string | null; box: MapBox | null; onAsked: (p: Post) => void; onCancel: () => void }) {
  const { t, toast, flags } = useSession();
  const voiceOn = flags.YAPS !== false;
  const [mode, setMode] = useState<'say' | 'write'>(voiceOn ? 'say' : 'write');
  const [recording, setRecording] = useState<Recording | null>(null);
  const [body, setBody] = useState('');
  const [topic, setTopic] = useState<AskTopic | null>(null);
  const [where, setWhere] = useState<Where>(box ? 'map' : 'city');
  const [cityText, setCityText] = useState(city ?? '');
  const [place, setPlace] = useState<TaggedPlace | null>(null);
  const [expiry, setExpiry] = useState<AskExpiry | 'none'>('none');
  const [expiryTouched, setExpiryTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!cityText && city) setCityText(city);
  }, [city]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickTopic = (next: AskTopic | null) => {
    setTopic(next);
    // Traffic is about now: it closes after an hour unless you chose otherwise.
    if (next && !expiryTouched) setExpiry(askDefaultExpiry(next) ?? 'none');
  };

  const ready = !!topic && (mode === 'say' ? !!recording : body.trim().length > 0) && (where !== 'place' || !!place) && (where !== 'city' || !!cityText.trim());

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!topic || !ready) return;
    setBusy(true);
    setProblem(null);
    try {
      let voiceId: string | undefined;
      if (mode === 'say' && recording) {
        try {
          voiceId = (await uploadVoice(recording, 'yap')).id;
        } catch (err) {
          setProblem(voiceError(err, t));
          return;
        }
      }
      const area = where === 'place' && place ? { placeId: place.id } : where === 'map' && box ? { box, ...(city ? { city } : {}) } : { city: cityText.trim() };
      const r = await api.askCity.ask({
        topic,
        body: body.trim(),
        ...(voiceId ? { voiceId } : {}),
        area,
        expires: expiry === 'none' ? null : expiry,
        timeZone: zone(),
      });
      const held = noticeText(r.moderation, t);
      toast(held ?? t('askCity.posted'));
      onAsked(r.post);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={t('askCity.ask')} level={2}>
      <form className="stack askcity-form" onSubmit={submit}>
        {voiceOn ? (
          <div className="askcity-chips" role="group" aria-label={t('askCity.ask')}>
            <button type="button" className="askcity-chip" aria-pressed={mode === 'say'} onClick={() => setMode('say')}>
              {t('askCity.say')}
            </button>
            <button type="button" className="askcity-chip" aria-pressed={mode === 'write'} onClick={() => setMode('write')}>
              {t('askCity.write')}
            </button>
          </div>
        ) : null}
        {mode === 'say' ? (
          <>
            <YapRecorder
              maxMs={VOICE_MAX_MS}
              label={t('askCity.say')}
              onDone={(blob, durationMs, filename) => setRecording({ blob, durationMs, filename })}
              onReset={() => setRecording(null)}
            />
            <TextField label={t('voice.lineLabel')} value={body} maxLength={ASK_TEXT_MAX} onChange={(e) => setBody(e.currentTarget.value)} />
          </>
        ) : (
          <TextField
            label={t('askCity.ask')}
            multiline
            rows={3}
            value={body}
            maxLength={ASK_TEXT_MAX}
            placeholder={t('askCity.placeholder')}
            onChange={(e) => setBody(e.currentTarget.value)}
          />
        )}

        <div className="askcity-fieldset">
          {/* The group is named "Topic" already; this is the same word for sighted people. */}
          <p className="askcity-legend" aria-hidden="true">
            {t('askCity.topic')}
          </p>
          <TopicChips value={topic} onChange={pickTopic} label={t('askCity.topic')} />
        </div>
        {topic === 'safety' ? (
          <p className="askcity-note" role="note">
            {t('askCity.safetyNote')}
          </p>
        ) : null}

        <fieldset className="askcity-fieldset">
          <legend>{t('askCity.where')}</legend>
          <div className="askcity-where">
            {box ? (
              <label className="askcity-radio">
                <input type="radio" name="ask-where" checked={where === 'map'} onChange={() => setWhere('map')} />
                {t('askCity.mapArea')}
              </label>
            ) : null}
            <label className="askcity-radio">
              <input type="radio" name="ask-where" checked={where === 'city'} onChange={() => setWhere('city')} />
              {t('place.edit.city')}
            </label>
            {where === 'city' ? (
              <TextField label={t('place.edit.city')} value={cityText} maxLength={60} onChange={(e) => setCityText(e.currentTarget.value)} />
            ) : null}
            <label className="askcity-radio">
              <input type="radio" name="ask-where" checked={where === 'place'} onChange={() => setWhere('place')} />
              {t('map.tagPlace')}
            </label>
            {where === 'place' ? <PlacePicker value={place} onChange={setPlace} /> : null}
          </div>
          <p className="muted askcity-hint">{t('askCity.areaNote')}</p>
        </fieldset>

        <Select
          label={t('askCity.openFor')}
          value={expiry}
          onChange={(e) => {
            setExpiryTouched(true);
            setExpiry(e.currentTarget.value as AskExpiry | 'none');
          }}
        >
          <option value="none">{t('askCity.expiry.none')}</option>
          {ASK_EXPIRIES.map((x) => (
            <option key={x} value={x}>
              {t(ASK_EXPIRY_KEYS[x])}
            </option>
          ))}
        </Select>

        {problem ? <Alert tone="danger">{problem}</Alert> : null}
        <div className="row">
          <Button type="submit" loading={busy} disabled={!ready}>
            {t('askCity.ask')}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** "Help answer questions near me": off by default; at most 3 notifications a day, in the topics chosen. */
export function HelperCard() {
  const { t, toast } = useSession();
  const [s, setS] = useState<AskHelperSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.askCity
      .settings()
      .then((r) => setS(r.settings))
      .catch(() => {});
  }, []);
  if (!s) return null;
  const save = async (next: { on: boolean; topics?: AskTopic[] }) => {
    setBusy(true);
    try {
      setS((await api.askCity.setSettings(next)).settings);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={t('askCity.helpers.title')} level={2}>
      <div className="stack-sm">
        {s.city ? (
          <>
            <Switch label={t('askCity.helpers.title')} checked={s.on} disabled={busy} onChange={(on) => void save({ on })} />
            <p className="muted askcity-hint">{t('askCity.helpers.hint', { city: s.city })}</p>
            {s.on ? (
              <div className="askcity-chips" role="group" aria-label={t('askCity.topic')}>
                {ASK_TOPICS.map((topic) => {
                  const on = s.topics.includes(topic);
                  return (
                    <button
                      key={topic}
                      type="button"
                      className="askcity-chip"
                      aria-pressed={on}
                      disabled={busy || (on && s.topics.length === 1)}
                      onClick={() => void save({ on: true, topics: on ? s.topics.filter((x) => x !== topic) : [...s.topics, topic] })}
                    >
                      {t(ASK_TOPIC_KEYS[topic])}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted askcity-hint">{t('askCity.noCity')}</p>
        )}
      </div>
    </Card>
  );
}
