import { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import type { FamilyLink, TeenControls } from '../../../packages/api-client/src/index';
import { client, errorMessage } from '../lib/api';
import { useSession } from '../lib/session';
import { radius, space } from '../lib/theme';
import { Avatar, Button, Card, Field, Loading, Notice, Segmented, SwitchRow, Title, useColors } from '../lib/ui';

/** Settings: family supervision and advertising consent (same endpoints as the web settings page). */
export default function Settings() {
  const c = useColors();
  const { me } = useSession();
  if (me === undefined) return <Loading />;
  if (!me)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice>Log in from the Home tab.</Notice>
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
      <Title sub="Sponsored posts are always labelled. They are only shown to adults who turn this on, and never to supervised accounts.">Advertising</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {granted === null && !error ? (
        <Loading />
      ) : granted !== null ? (
        <SwitchRow
          label="Show me sponsored posts based on my interests"
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

function describe(ctl: TeenControls): string {
  const parts = [ctl.messagesFrom === 'nobody' ? 'Only family can message you.' : 'Only friends and family can message you.'];
  if (ctl.dailyLimitMinutes) parts.push(`A reminder after ${ctl.dailyLimitMinutes} minutes a day.`);
  if (ctl.quietStart && ctl.quietEnd) parts.push(`Quiet hours ${ctl.quietStart} to ${ctl.quietEnd} (${ctl.timezone}): notifications wait until morning.`);
  return parts.join(' ');
}

/**
 * Family supervision. Guardians invite a teen by username; the teen accepts. Guardians set
 * who the teen can message, a daily reminder and quiet hours, and see daily minutes. They
 * never see messages or activity.
 */
function Family() {
  const c = useColors();
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
      <Title sub="Supervise a teen's account together. Guardians never see messages, posts in private spaces or searches.">Family</Title>
      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? <Loading /> : null}
      {items?.map((l) => {
        const other = l.role === 'guardian' ? l.teen : l.guardian;
        const status =
          l.status === 'pending'
            ? l.role === 'teen'
              ? 'Wants to supervise your account'
              : 'Invitation sent'
            : l.role === 'guardian'
              ? 'You supervise this account'
              : 'Supervises your account';
        return (
          <View key={l.id} style={{ gap: space[3] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
              <Avatar name={other?.displayName ?? '?'} url={other?.avatarUrl ?? null} size={40} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontWeight: '700' }} numberOfLines={1}>
                  {other?.displayName ?? 'Account'}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{status}</Text>
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: space[2] }}>
              {l.status === 'pending' && l.role === 'teen' ? (
                <Button label="Accept" size="sm" onPress={() => act(async () => (await client()).family.accept(l.id), 'Family link accepted.')} />
              ) : null}
              <Button
                label={l.status === 'pending' && l.role === 'teen' ? 'Decline' : l.status === 'pending' ? 'Cancel' : 'End'}
                size="sm"
                variant="secondary"
                onPress={() => act(async () => (await client()).family.end(l.id), l.status === 'pending' ? 'Declined.' : 'Family link ended.')}
              />
            </View>
            {l.status === 'active' && l.controls ? (
              l.role === 'guardian' ? (
                <GuardianControls link={l} onSaved={load} />
              ) : (
                <Notice title={`${l.guardian?.displayName ?? 'Your guardian'} set these for you`}>{describe(l.controls)}</Notice>
              )
            ) : null}
          </View>
        );
      })}
      <View style={{ gap: space[2] }}>
        <Field
          label="Supervise a teen (their username)"
          placeholder="@username"
          autoCapitalize="none"
          autoCorrect={false}
          value={username}
          onChangeText={setUsername}
        />
        <Button
          label="Invite"
          variant="secondary"
          disabled={!username.trim()}
          onPress={() =>
            act(async () => (await client()).family.invite(username.trim().replace(/^@/, '')), 'Invitation sent. They need to accept it.').then(() =>
              setUsername(''),
            )
          }
        />
      </View>
    </Card>
  );
}

const LIMITS = [null, 30, 60, 90, 120, 180] as const;
const limitLabel = (m: number | null) => (m === null ? 'Off' : m >= 60 ? `${m / 60}h` : `${m}m`);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function GuardianControls({ link, onSaved }: { link: FamilyLink; onSaved: () => Promise<void> }) {
  const c = useColors();
  const [ctl, setCtl] = useState<TeenControls>(link.controls!);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const week = link.usage ?? [];
  const max = Math.max(60, ...week.map((d) => d.minutes));
  const limitOptions = LIMITS.map((m) => ({ id: String(m) as string, label: limitLabel(m) }));
  const quietValid = (!ctl.quietStart && !ctl.quietEnd) || (HHMM.test(ctl.quietStart ?? '') && HHMM.test(ctl.quietEnd ?? ''));

  return (
    <View style={{ gap: space[3], backgroundColor: c.surfaceSunken, borderRadius: radius.md, padding: space[3] }}>
      <Text style={{ color: c.ink, fontWeight: '700' }}>{link.teen?.displayName ?? 'Supervised account'}</Text>
      {week.length ? (
        <View
          accessible
          accessibilityLabel={`Minutes per day, last 7 days: ${week.map((d) => d.minutes).join(', ')}`}
          style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space[2], height: 84 }}
        >
          {week.map((d) => (
            <View key={d.day} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
              <View style={{ width: '70%', height: Math.max(4, (d.minutes / max) * 64), borderRadius: 4, backgroundColor: c.yapi }} />
              <Text style={{ color: c.inkMuted, fontSize: 11 }}>{new Date(d.day).toLocaleDateString(undefined, { weekday: 'narrow' })}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.inkMuted }}>No time recorded this week yet.</Text>
      )}
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>Who can message them</Text>
      <Segmented
        label="Who can message them"
        options={[
          { id: 'friends', label: 'Friends and family' },
          { id: 'nobody', label: 'Family only' },
        ]}
        value={ctl.messagesFrom}
        onChange={(v) => setCtl({ ...ctl, messagesFrom: v })}
      />
      <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>Daily reminder</Text>
      <Segmented
        label="Daily reminder"
        options={limitOptions}
        value={String(ctl.dailyLimitMinutes)}
        onChange={(v) => setCtl({ ...ctl, dailyLimitMinutes: v === 'null' ? null : Number(v) })}
      />
      <View style={{ flexDirection: 'row', gap: space[2] }}>
        <View style={{ flex: 1 }}>
          <Field
            label="Quiet from"
            placeholder="21:00"
            keyboardType="numbers-and-punctuation"
            value={ctl.quietStart ?? ''}
            onChangeText={(t) => setCtl({ ...ctl, quietStart: t.trim() || null })}
          />
        </View>
        <View style={{ flex: 1 }}>
          <Field
            label="Until"
            placeholder="07:00"
            keyboardType="numbers-and-punctuation"
            value={ctl.quietEnd ?? ''}
            onChangeText={(t) => setCtl({ ...ctl, quietEnd: t.trim() || null })}
          />
        </View>
      </View>
      {!quietValid ? <Text style={{ color: c.danger, fontSize: 13 }}>Use 24-hour times like 21:00, and set both or neither.</Text> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {saved ? <Text style={{ color: c.success, fontSize: 13 }}>Saved. {link.teen?.displayName ?? 'They'} will be told.</Text> : null}
      <Button
        label={saving ? 'Saving…' : 'Save settings'}
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
