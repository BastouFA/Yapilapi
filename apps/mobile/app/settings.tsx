import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { FamilyLink, TeenControls } from '../../../packages/api-client/src/index';
import { client, errorMessage } from '../lib/api';
import { useT, type Translator } from '../lib/i18n';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Card, Field, Loading, Notice, Segmented, SwitchRow, Title, useColors, userText } from '../lib/ui';

/** Settings: family supervision and advertising consent (same endpoints as the web settings page). */
export default function Settings() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>{t('m.common.signedOut')}</Notice>
      </View>
    );
  return (
    <ScrollView
      style={{ backgroundColor: c.ground }}
      contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
      keyboardShouldPersistTaps="handled"
    >
      <Family />
      <Advertising />
    </ScrollView>
  );
}

function Advertising() {
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
function Family() {
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
