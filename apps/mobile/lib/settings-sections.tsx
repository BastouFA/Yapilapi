/**
 * Settings sections moved from the old single Settings screen: sharing, photo tags, hidden words,
 * data saver, translation, sponsored posts and family supervision (same endpoints as the web).
 */
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { FamilyLink, SharingSettings, TeenControls } from '../../../packages/api-client/src/index';
import type { TagPermission } from '../../../packages/shared/src/types';
import { client, errorMessage } from './api';
import { useT, type Translator } from './i18n';
import { radius, space } from './theme';
import { Avatar, Button, Card, Field, Icon, Loading, Notice, Segmented, SwitchRow, Title, useColors, userText } from './ui';
import { CAN_DETECT_CELLULAR, useDataSaver, type DeviceDataSaver } from './data-saver';
import type { DataSaverMode } from '../../../packages/shared/src/data-saver';
import { HIDDEN_WORD_MAX, HIDDEN_WORDS_MAX } from '../../../packages/shared/src/constants';
import { baseLanguage, languageName, MAX_UNDERSTOOD_LANGUAGES, TRANSLATION_LANGUAGES } from '../../../packages/shared/src/translation';
import { useTranslationSettings } from './translation';

/** "Let people who have my email or phone number find me" and "Allow downloads of my reels". Both stay off under 18. */
export function Sharing() {
  const { t } = useT();
  const [settings, setSettings] = useState<SharingSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client()
      .then((api) => api.me.sharing())
      .then((r) => setSettings(r.settings))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const set = async (k: 'findableByContacts' | 'allowDownload', v: boolean) => {
    if (!settings) return;
    const before = settings;
    setSettings({ ...settings, [k]: v });
    setError(null);
    try {
      setSettings((await (await client()).me.setSharing({ [k]: v })).settings);
    } catch (e) {
      setSettings(before);
      setError(errorMessage(e));
    }
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={settings?.locked ? t('sharing.locked') : undefined}>{t('sharing.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <>
          <SwitchRow
            label={t('sharing.findable')}
            hint={t('sharing.findable.hint')}
            value={settings.findableByContacts}
            disabled={settings.locked}
            onValueChange={(v) => void set('findableByContacts', v)}
          />
          <SwitchRow
            label={t('sharing.allowDownload')}
            hint={t('sharing.allowDownload.hint')}
            value={settings.allowDownload}
            disabled={settings.locked}
            onValueChange={(v) => void set('allowDownload', v)}
          />
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

/** Who can tag you in photos: everyone, people you follow, or no one. */
export function Tagging() {
  const c = useColors();
  const { t } = useT();
  const [allowFrom, setAllowFrom] = useState<TagPermission | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client()
      .then((api) => api.me.tagging())
      .then((r) => setAllowFrom(r.allowFrom))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const set = async (v: TagPermission) => {
    const before = allowFrom;
    setAllowFrom(v);
    setError(null);
    try {
      setAllowFrom((await (await client()).me.setTagging(v)).allowFrom);
    } catch (e) {
      setAllowFrom(before);
      setError(errorMessage(e));
    }
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('m.tagging.body')}>{t('m.tagging.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {allowFrom ? (
        <View accessibilityRole="radiogroup" accessibilityLabel={t('m.tagging.title')} style={{ gap: space[1] }}>
          {(
            [
              ['everyone', 'm.tagging.everyone'],
              ['following', 'm.tagging.following'],
              ['nobody', 'm.tagging.nobody'],
            ] as const
          ).map(([id, label]) => {
            const on = allowFrom === id;
            return (
              <Pressable
                key={id}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                onPress={() => !on && void set(id)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
              >
                <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
                <Text style={{ color: c.ink, fontSize: 15, fontWeight: on ? '700' : '500' }}>{t(label)}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

/** Hidden words: comments on your posts containing one are hidden from everyone but their writer. */
export function HiddenWords() {
  const c = useColors();
  const { t } = useT();
  const [words, setWords] = useState<string[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client()
      .then((api) => api.me.hiddenWords())
      .then((r) => setWords(r.words))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  const save = async (next: string[]) => {
    const before = words;
    setWords(next);
    setBusy(true);
    setError(null);
    try {
      setWords((await (await client()).me.setHiddenWords(next)).words);
    } catch (e) {
      setWords(before);
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const full = (words?.length ?? 0) >= HIDDEN_WORDS_MAX;
  const add = () => {
    const w = draft.trim().toLowerCase().replace(/\s+/g, ' ');
    setDraft('');
    if (w && words && !words.includes(w)) void save([...words, w]);
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('hiddenWords.body')}>{t('hiddenWords.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {words ? (
        <>
          <View style={{ flexDirection: 'row', gap: space[2], alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <Field
                label={t('hiddenWords.label')}
                placeholder={t('hiddenWords.placeholder')}
                value={draft}
                onChangeText={setDraft}
                maxLength={HIDDEN_WORD_MAX}
                editable={!full}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={add}
              />
            </View>
            <Button label={t('hiddenWords.add')} variant="secondary" disabled={!draft.trim() || full || busy} onPress={add} />
          </View>
          {full ? <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('hiddenWords.max', { count: HIDDEN_WORDS_MAX })}</Text> : null}
          {words.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {words.map((w) => (
                <Pressable
                  key={w}
                  accessibilityRole="button"
                  accessibilityLabel={t('hiddenWords.remove', { word: w })}
                  disabled={busy}
                  onPress={() => void save(words.filter((x) => x !== w))}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 4,
                    minHeight: 36,
                    paddingHorizontal: space[3],
                    borderRadius: radius.full,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: c.surface,
                  }}
                >
                  <Text style={[{ color: c.ink, fontSize: 13 }, userText]}>{w}</Text>
                  <Icon name="close" size={14} color={c.inkMuted} />
                </Pressable>
              ))}
            </View>
          ) : (
            <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('hiddenWords.none')}</Text>
          )}
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

/**
 * Data saver: Off / On / Automatic on the account (it follows the person to other devices),
 * and this phone's own choice. Automatic needs to know Wi-Fi from mobile data, which this
 * app can't tell yet, so on the phone it works like Off and the card says so.
 */
export function DataSaver() {
  const c = useColors();
  const { t } = useT();
  const ds = useDataSaver();
  const [error, setError] = useState<string | null>(null);
  const modes: { id: DataSaverMode; label: string }[] = [
    { id: 'off', label: t('dataSaver.off') },
    { id: 'on', label: t('dataSaver.on') },
    { id: 'auto', label: t('dataSaver.auto') },
  ];
  const deviceChoices: { id: DeviceDataSaver; label: string }[] = [{ id: 'account', label: t('dataSaver.deviceAccount') }, ...modes];
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('dataSaver.hint')}>{t('dataSaver.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Segmented
        options={modes}
        value={ds.account}
        label={t('dataSaver.title')}
        onChange={(v) => {
          setError(null);
          ds.setAccount(v).catch((e) => setError(errorMessage(e)));
        }}
      />
      <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('dataSaver.account')}</Text>
      {!CAN_DETECT_CELLULAR && (ds.mode === 'auto' || ds.account === 'auto') ? <Notice>{t('dataSaver.autoMobile')}</Notice> : null}
      <View accessibilityRole="radiogroup" accessibilityLabel={t('dataSaver.device')} style={{ gap: space[1] }}>
        <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{t('dataSaver.device')}</Text>
        {deviceChoices.map(({ id, label }) => {
          const on = ds.device === id;
          return (
            <Pressable
              key={id}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              onPress={() => ds.setDevice(id)}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}
            >
              <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
              <Text style={{ color: c.ink, fontSize: 15, fontWeight: on ? '700' : '500' }}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text accessibilityLiveRegion="polite" style={{ color: c.ink, fontSize: 14, fontWeight: '600' }}>
        {ds.active ? t('dataSaver.nowOn') : t('dataSaver.nowOff')}
      </Text>
    </Card>
  );
}

/**
 * "Languages I understand" (the app's language always counts, so it's ticked and fixed)
 * and "Translate automatically" (off by default). Saved on the account.
 */
export function Translation() {
  const c = useColors();
  const { t, lang, locale } = useT();
  const { enabled, settings, save } = useTranslationSettings();
  const [error, setError] = useState<string | null>(null);
  const app = baseLanguage(lang);
  const listed = settings.languages.filter((l) => l !== app);
  const full = listed.length >= MAX_UNDERSTOOD_LANGUAGES;
  const update = (next: typeof settings) => {
    setError(null);
    save(next).catch((e) => setError(errorMessage(e)));
  };
  return (
    <Card style={{ gap: space[3] }}>
      <Title>{t('translate.settingsTitle')}</Title>
      {!enabled ? <Notice>{t('translate.off')}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View style={{ gap: space[1] }}>
        <Text accessibilityRole="header" style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>
          {t('translate.languages')}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('translate.languagesHint', { language: languageName(app, locale) })}</Text>
        {TRANSLATION_LANGUAGES.map((l) => {
          const isApp = l.code === app;
          const on = isApp || listed.includes(l.code);
          const disabled = isApp || (full && !on);
          const local = languageName(l.code, locale);
          const sub = isApp ? t('translate.appLanguage') : local.toLowerCase() !== l.autonym.toLowerCase() ? local : undefined;
          return (
            <Pressable
              key={l.code}
              accessibilityRole="checkbox"
              accessibilityLabel={sub ? `${l.autonym}, ${sub}` : l.autonym}
              accessibilityLanguage={l.code}
              accessibilityState={{ checked: on, disabled }}
              disabled={disabled}
              onPress={() => update({ ...settings, languages: on ? listed.filter((x) => x !== l.code) : [...listed, l.code] })}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44, opacity: disabled && !isApp ? 0.5 : 1 }}
            >
              <Icon name={on ? 'checkbox' : 'square-outline'} size={22} color={on ? c.yapi : c.inkMuted} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontSize: 15, fontWeight: on ? '700' : '500' }, userText]}>{l.autonym}</Text>
                {sub ? <Text style={{ color: c.inkMuted, fontSize: 12 }}>{sub}</Text> : null}
              </View>
            </Pressable>
          );
        })}
        {full ? (
          <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
            {t('translate.max', { count: MAX_UNDERSTOOD_LANGUAGES })}
          </Text>
        ) : null}
      </View>
      <SwitchRow label={t('translate.auto')} hint={t('translate.autoHint')} value={settings.auto} onValueChange={(v) => update({ ...settings, auto: v })} />
    </Card>
  );
}

export function Advertising() {
  const { t } = useT();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    client()
      .then((api) => api.me.privacy())
      .then((r) => setGranted(!!r.consents.find((x) => x.purpose === 'advertising')?.granted))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('m.ads.body')}>{t('m.ads.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {granted === null && !error ? (
        <Loading />
      ) : granted !== null ? (
        <SwitchRow
          label={t('m.ads.switch')}
          value={granted}
          onValueChange={async (v) => {
            setGranted(v);
            setError(null);
            try {
              await (await client()).me.setConsent('advertising', v);
            } catch (e) {
              setGranted(!v);
              setError(errorMessage(e));
            }
          }}
        />
      ) : null}
    </Card>
  );
}

function describe(ctl: TeenControls, { t }: Translator): string {
  const parts = [ctl.messagesFrom === 'nobody' ? t('m.family.rule.familyOnly') : t('m.family.rule.friends')];
  if (ctl.dailyLimitMinutes) parts.push(t('m.family.rule.limit', { minutes: ctl.dailyLimitMinutes }));
  if (ctl.quietStart && ctl.quietEnd) parts.push(t('m.family.rule.quiet', { start: ctl.quietStart, end: ctl.quietEnd, timezone: ctl.timezone }));
  return parts.join(' ');
}

/**
 * Family supervision. Guardians invite a teen by username; the teen accepts. Guardians set
 * who the teen can message, a daily reminder and quiet hours, and see daily minutes. They
 * never see messages or activity.
 */
export function Family() {
  const c = useColors();
  const i18n = useT();
  const { t } = i18n;
  const [items, setItems] = useState<FamilyLink[] | null>(null);
  const [username, setUsername] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems((await (await client()).family.list()).items);
    } catch (e) {
      setItems([]);
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setError(null);
    try {
      await fn();
      setNote(done);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('m.family.body')}>{t('m.family.title')}</Title>
      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? <Loading /> : null}
      {items?.map((l) => {
        const other = l.role === 'guardian' ? l.teen : l.guardian;
        const status =
          l.status === 'pending'
            ? l.role === 'teen'
              ? t('m.family.status.wants')
              : t('m.family.status.invited')
            : l.role === 'guardian'
              ? t('m.family.status.guardian')
              : t('m.family.status.teen');
        return (
          <View key={l.id} style={{ gap: space[3] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
              <Avatar name={other?.displayName ?? '?'} url={other?.avatarUrl ?? null} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={[{ color: c.ink, fontWeight: '700' }, userText]} numberOfLines={1}>
                  {other?.displayName ?? t('m.family.account')}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{status}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: space[2] }}>
              {l.status === 'pending' && l.role === 'teen' ? (
                <Button label={t('m.common.accept')} size="sm" onPress={() => act(async () => (await client()).family.accept(l.id), t('m.family.accepted'))} />
              ) : null}
              <Button
                label={l.status === 'pending' && l.role === 'teen' ? t('m.common.decline') : l.status === 'pending' ? t('common.cancel') : t('m.family.end')}
                size="sm"
                variant="secondary"
                onPress={() => act(async () => (await client()).family.end(l.id), l.status === 'pending' ? t('m.family.declined') : t('m.family.ended'))}
              />
            </View>
            {l.status === 'active' && l.controls ? (
              l.role === 'guardian' ? (
                <GuardianControls link={l} onSaved={load} />
              ) : (
                <Notice title={t('m.family.setForYou', { name: l.guardian?.displayName ?? t('m.family.yourGuardian') })}>{describe(l.controls, i18n)}</Notice>
              )
            ) : null}
          </View>
        );
      })}
      <View style={{ gap: space[2] }}>
        <Field
          label={t('m.family.invite.label')}
          placeholder={t('m.family.invite.placeholder')}
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />
        <Button
          label={t('m.family.invite')}
          variant="secondary"
          disabled={!username.trim()}
          onPress={() =>
            act(async () => (await client()).family.invite(username.trim().replace(/^@/, '')), t('m.family.invite.sent')).then(() => setUsername(''))
          }
        />
      </View>
    </Card>
  );
}

const LIMITS = [null, 30, 60, 90, 120, 180] as const;
const limitLabel = (m: number | null, { t }: Translator) =>
  m === null ? t('m.family.limit.off') : m >= 60 ? t('m.unit.hours', { count: m / 60 }) : t('m.unit.minutes', { count: m });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function GuardianControls({ link, onSaved }: { link: FamilyLink; onSaved: () => Promise<void> }) {
  const c = useColors();
  const i18n = useT();
  const { t, number, date } = i18n;
  const [ctl, setCtl] = useState<TeenControls>(link.controls!);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const week = link.usage ?? [];
  const max = Math.max(60, ...week.map((d) => d.minutes));
  const limitOptions = LIMITS.map((m) => ({ id: String(m) as string, label: limitLabel(m, i18n) }));
  const quietValid = (!ctl.quietStart && !ctl.quietEnd) || (HHMM.test(ctl.quietStart ?? '') && HHMM.test(ctl.quietEnd ?? ''));

  return (
    <View style={{ gap: space[3], backgroundColor: c.surfaceSunken, borderRadius: radius.md, padding: space[3] }}>
      <Text style={[{ color: c.ink, fontWeight: '700' }, userText]}>{link.teen?.displayName ?? t('m.family.supervised')}</Text>
      {week.length ? (
        <View
          accessible
          accessibilityLabel={t('m.family.week', { minutes: week.map((d) => number(d.minutes)).join(', ') })}
          style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space[2], height: 84 }}
        >
          {week.map((d) => (
            <View key={d.day} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
              <View style={{ width: '70%', height: Math.max(4, (d.minutes / max) * 64), borderRadius: 4, backgroundColor: c.yapi }} />
              <Text style={{ color: c.inkMuted, fontSize: 11 }}>{date(d.day, { weekday: 'narrow' })}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('m.family.noUsage')}</Text>
      )}
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.family.whoCanMessage')}</Text>
      <Segmented
        label={t('m.family.whoCanMessage')}
        options={[
          { id: 'friends', label: t('m.family.friendsAndFamily') },
          { id: 'nobody', label: t('m.family.familyOnly') },
        ]}
        value={ctl.messagesFrom}
        onChange={(v) => setCtl({ ...ctl, messagesFrom: v })}
      />
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.family.dailyReminder')}</Text>
      <Segmented
        label={t('m.family.dailyReminder')}
        options={limitOptions}
        value={String(ctl.dailyLimitMinutes)}
        onChange={(v) => setCtl({ ...ctl, dailyLimitMinutes: v === 'null' ? null : Number(v) })}
      />
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        <View style={{ flex: 1 }}>
          <Field
            label={t('m.family.quietFrom')}
            placeholder="21:00"
            keyboardType="numbers-and-punctuation"
            value={ctl.quietStart ?? ''}
            onChangeText={(t) => setCtl({ ...ctl, quietStart: t.trim() || null })}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label={t('m.family.until')}
            placeholder="07:00"
            keyboardType="numbers-and-punctuation"
            value={ctl.quietEnd ?? ''}
            onChangeText={(t) => setCtl({ ...ctl, quietEnd: t.trim() || null })}
          />
        </View>
      </View>
      {!quietValid ? <Text style={{ color: c.danger, fontSize: 13 }}>{t('m.family.quietInvalid')}</Text> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {saved ? (
        <Text style={{ color: c.success, fontSize: 13 }}>
          {link.teen?.displayName ? t('m.family.savedTold', { name: link.teen.displayName }) : t('m.family.savedToldThem')}
        </Text>
      ) : null}
      <Button
        label={saving ? t('m.common.saving') : t('m.family.save')}
        size="sm"
        disabled={saving || !quietValid}
        onPress={async () => {
          setSaving(true);
          setError(null);
          setSaved(false);
          try {
            await (await client()).family.setControls(link.id, { ...ctl, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' });
            setSaved(true);
            await onSaved();
          } catch (e) {
            setError(errorMessage(e));
          } finally {
            setSaving(false);
          }
        }}
      />
    </View>
  );
}
