import Constants from 'expo-constants';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Linking, Platform, Pressable, Text, View } from 'react-native';
import type { AccountInfo, InteractionSettings, PublicUser } from '../../../packages/shared/src/types';
import { SUPPORTED_LOCALES } from '../../../packages/shared/src/i18n';
import { LEGAL_DOCS } from '../../../packages/shared/src/legal';
import { client, errorMessage, webUrl } from './api';
import { AppearanceSegments, goHome } from './account-menu';
import { useAppearance } from './appearance';
import { PasswordField } from './auth-ui';
import { useT } from './i18n';
import { openLegal } from './legal';
import { registerForPush } from './push';
import { useSession } from './session';
import { radius, space } from './theme';
import { Avatar, Button, Card, Field, Icon, Loading, Notice, SwitchRow, Title, useColors, userText, type IconName } from './ui';

/**
 * The parts of Settings that are new on the phone: account details, password, two-step
 * verification, logging out everywhere, sign-in activity, connected apps, who can reach you,
 * muted and restricted people, quiet hours, sensitive content, the app's language, appearance,
 * reporting a problem and the app version. Same endpoints as the web settings pages.
 */

export const APP_VERSION = Constants.expoConfig?.version ?? '1.0.0';

/** A row that opens something: icon in a soft squircle, title, one line about it, chevron. */
export function SettingsLinkRow({
  icon,
  title,
  desc,
  onPress,
  external,
}: {
  icon: IconName;
  title: string;
  desc?: string;
  onPress: () => void;
  external?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole={external ? 'link' : 'button'}
      accessibilityLabel={desc ? `${title}, ${desc}` : title}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space[3],
        minHeight: 60,
        paddingVertical: space[2],
        paddingHorizontal: space[3],
        borderRadius: radius.md,
        backgroundColor: pressed ? c.surfaceSunken : 'transparent',
      })}
    >
      <View style={{ width: 38, height: 38, borderRadius: 12, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={20} color={c.yapi} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{title}</Text>
        {desc ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{desc}</Text> : null}
      </View>
      <Icon name={external ? 'open-outline' : 'chevron-forward'} size={18} color={c.inkMuted} directional={!external} />
    </Pressable>
  );
}

/** A group of rows on one surface, with a heading above. */
export function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: space[2] }}>
      {title ? (
        <Text
          accessibilityRole="header"
          style={{ color: c.inkMuted, fontSize: 13, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase', marginStart: space[1] }}
        >
          {title}
        </Text>
      ) : null}
      <Card style={{ padding: 6, gap: 0 }}>{children}</Card>
    </View>
  );
}

/** Radio choices, applied as soon as one is picked. */
export function Choices<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ gap: 2, opacity: disabled ? 0.6 : 1 }}>
      <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700', marginBottom: space[1] }}>{label}</Text>
      {options.map((o) => {
        const on = value === o.id;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ checked: on, disabled: !!disabled }}
            accessibilityHint={o.hint}
            disabled={disabled}
            onPress={() => !on && onChange(o.id)}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space[3], minHeight: 44, paddingVertical: space[2] }}
          >
            <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: c.ink, fontSize: 15, fontWeight: on ? '700' : '500' }}>{o.label}</Text>
              {o.hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{o.hint}</Text> : null}
            </View>
          </Pressable>
        );
      })}
      {hint ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{hint}</Text> : null}
    </View>
  );
}

/** Loads the interaction settings (who can reach you, quiet hours, sensitive media) and saves changes. */
function useInteractions() {
  const [settings, setSettings] = useState<InteractionSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.me.interactions())
      .then(
        (r) => setSettings(r.settings),
        (e) => setError(errorMessage(e)),
      );
  }, []);
  const save = async (patch: Partial<Omit<InteractionSettings, 'sensitiveLocked'>>) => {
    if (!settings) return false;
    const before = settings;
    setSettings({ ...settings, ...patch });
    setError(null);
    try {
      setSettings((await (await client()).me.setInteractions(patch)).settings);
      return true;
    } catch (e) {
      setSettings(before);
      setError(errorMessage(e));
      return false;
    }
  };
  return { settings, error, save };
}

// ── Account ─────────────────────────────────────────────────────────────

/** Your photo and name, and Edit profile. */
export function ProfileSummary() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  if (!me) return null;
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <Avatar name={me.displayName} url={me.avatarUrl} size={56} />
      <View style={{ flex: 1 }}>
        <Text style={[{ color: c.ink, fontSize: 18, fontWeight: '800' }, userText]} numberOfLines={1}>
          {me.displayName}
        </Text>
        <Text style={{ color: c.inkMuted, fontSize: 14 }} numberOfLines={1}>
          @{me.username}
        </Text>
      </View>
      <Button label={t('profile.edit')} size="sm" variant="secondary" onPress={() => router.push('/profile-edit')} />
    </Card>
  );
}

/** Username, date of birth and when you joined; read-only. */
export function AccountDetails() {
  const c = useColors();
  const { t, date } = useT();
  const { me } = useSession();
  const [account, setAccount] = useState<AccountInfo | null>(null);
  useEffect(() => {
    void client()
      .then((api) => api.me.account())
      .then(
        (r) => setAccount(r.account),
        () => {},
      );
  }, []);
  if (!me) return null;
  const fact = (label: string, value: string, hint?: string) => (
    <View style={{ gap: 2 }}>
      <Text style={{ color: c.inkMuted, fontSize: 13, fontWeight: '600' }}>{label}</Text>
      <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{value}</Text>
      {hint ? <Text style={{ color: c.inkMuted, fontSize: 12, lineHeight: 16 }}>{hint}</Text> : null}
    </View>
  );
  const long = (iso: string) => date(iso, { dateStyle: 'long', timeZone: 'UTC' });
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.signin.desc')}>{t('st.signin.title')}</Title>
      {fact(t('auth.username'), `@${me.username}`, t('st.username.hint'))}
      {fact(t('auth.birthDate'), account ? (account.birthDate ? long(`${account.birthDate}T00:00:00Z`) : t('st.birthDate.none')) : '…', t('st.birthDate.hint'))}
      {account ? fact(t('st.memberSince'), long(account.createdAt)) : null}
    </Card>
  );
}

/** Change your password; other devices are signed out, this phone stays signed in. */
export function ChangePassword() {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const mismatch = !!again && next !== again;
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.password.desc')}>{t('st.password.title')}</Title>
      {note ? <Notice>{note}</Notice> : null}
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <PasswordField
        t={t}
        label={t('st.password.current')}
        value={current}
        onChangeText={setCurrent}
        autoComplete="current-password"
        textContentType="password"
        error={fields.currentPassword}
      />
      <PasswordField
        t={t}
        label={t('st.password.new')}
        value={next}
        onChangeText={setNext}
        autoComplete="new-password"
        textContentType="newPassword"
        hint={t('auth.password.hint')}
        error={fields.newPassword}
      />
      <PasswordField
        t={t}
        label={t('st.password.confirm')}
        value={again}
        onChangeText={setAgain}
        autoComplete="new-password"
        textContentType="newPassword"
        error={mismatch ? t('st.password.mismatch') : null}
      />
      <Button
        label={t('st.password.change')}
        disabled={!current || next.length < 10 || next !== again}
        onPress={async () => {
          setError(null);
          setNote(null);
          setFields({});
          try {
            await (await client()).auth.changePassword(current, next);
            setCurrent('');
            setNext('');
            setAgain('');
            setNote(t('st.password.changed'));
          } catch (e) {
            setError(errorMessage(e));
            const f = (e as { fields?: Record<string, string> }).fields ?? {};
            setFields({
              ...(f.currentPassword ? { currentPassword: t('st.password.wrong') } : {}),
              ...(f.newPassword ? { newPassword: t('auth.password.hint') } : {}),
            });
          }
        }}
      />
    </Card>
  );
}

// ── Security ────────────────────────────────────────────────────────────

/** Two-step verification: turn it on with an authenticator app (the key, or the app's setup link), or off. */
export function TwoStep() {
  const c = useColors();
  const { t, tp } = useT();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryCodesLeft: number } | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void client()
      .then((api) => api.mfa.status())
      .then(setStatus, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  if (!status) return error ? <Notice tone="danger">{error}</Notice> : <Loading />;
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={status.enabled ? tp('settings.twoStep.on', status.recoveryCodesLeft) : t('settings.twoStep.offHint')}>{t('settings.twoStep.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {codes ? (
        <Notice tone="warn" title={t('settings.twoStep.saveCodes')}>
          <Text style={{ color: c.ink, lineHeight: 20 }}>{t('settings.twoStep.codesHint')}</Text>
          <Text
            selectable
            style={{ color: c.ink, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 15, lineHeight: 24, marginTop: space[2] }}
          >
            {codes.join('\n')}
          </Text>
        </Notice>
      ) : null}
      {!status.enabled && !setup ? (
        <Button
          label={t('settings.twoStep.turnOn')}
          icon="shield-checkmark-outline"
          onPress={() => run(async () => setSetup(await (await client()).mfa.setup()))}
        />
      ) : null}
      {setup ? (
        <View style={{ gap: space[3] }}>
          <Text style={{ color: c.ink, lineHeight: 20 }}>{t('settings.twoStep.addKey')}</Text>
          <Text selectable style={{ color: c.ink, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 16, letterSpacing: 1 }}>
            {setup.secret.match(/.{1,4}/g)?.join(' ')}
          </Text>
          <Button
            label={t('settings.twoStep.openApp')}
            variant="secondary"
            icon="open-outline"
            onPress={() => void Linking.openURL(setup.otpauthUri).catch(() => {})}
          />
          <Field
            label={t('settings.twoStep.code')}
            value={code}
            onChangeText={setCode}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
          />
          <View style={{ flexDirection: 'row', gap: space[2] }}>
            <Button
              label={t('settings.twoStep.verify')}
              disabled={code.length !== 6}
              onPress={() =>
                run(async () => {
                  setCodes((await (await client()).mfa.confirm(code)).recoveryCodes);
                  setSetup(null);
                  setCode('');
                  load();
                })
              }
            />
            <Button label={t('common.cancel')} variant="ghost" onPress={() => setSetup(null)} />
          </View>
        </View>
      ) : null}
      {status.enabled && !disabling ? <Button label={t('settings.twoStep.turnOff')} variant="secondary" onPress={() => setDisabling(true)} /> : null}
      {disabling ? (
        <View style={{ gap: space[3] }}>
          <PasswordField
            t={t}
            label={t('auth.password')}
            value={password}
            onChangeText={setPassword}
            autoComplete="current-password"
            textContentType="password"
          />
          <Field label={t('settings.twoStep.codeOrRecovery')} value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} maxLength={12} />
          <View style={{ flexDirection: 'row', gap: space[2], flexWrap: 'wrap' }}>
            <Button
              label={t('settings.twoStep.turnOffFull')}
              variant="danger"
              disabled={!password || code.length < 6}
              onPress={() =>
                run(async () => {
                  await (await client()).mfa.disable(password, code);
                  setDisabling(false);
                  setPassword('');
                  setCode('');
                  setCodes(null);
                  load();
                })
              }
            />
            <Button label={t('common.cancel')} variant="ghost" onPress={() => setDisabling(false)} />
          </View>
        </View>
      ) : null}
    </Card>
  );
}

/** Passkeys need the browser for now: a row that opens the web's Security page. */
export function PasskeysOnWeb() {
  const { t } = useT();
  return (
    <SettingsGroup>
      <SettingsLinkRow
        icon="finger-print-outline"
        title={t('settings.passkeys.title')}
        desc={t('st.passkeys.web')}
        external
        onPress={() => void Linking.openURL(`${webUrl}/settings/security#passkeys`).catch(() => {})}
      />
    </SettingsGroup>
  );
}

/** Log out of every device, this phone included, after asking. */
export function LogoutEverywhere() {
  const { t } = useT();
  const { signOutEverywhere } = useSession();
  const [error, setError] = useState<string | null>(null);
  return (
    <View style={{ gap: space[2] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <Button
        label={t('st.logoutAll')}
        variant="danger"
        icon="log-out-outline"
        onPress={() =>
          Alert.alert(t('st.logoutAll.title'), t('st.logoutAll.body'), [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('st.logoutAll'),
              style: 'destructive',
              onPress: async () => {
                setError(null);
                try {
                  if ((await signOutEverywhere()) === 'switched') goHome();
                } catch (e) {
                  setError(errorMessage(e));
                }
              },
            },
          ])
        }
      />
    </View>
  );
}

const EVENTS: Record<string, Parameters<ReturnType<typeof useT>['t']>[0]> = {
  login: 'st.event.login',
  login_failed: 'st.event.login_failed',
  login_password_ok_mfa_pending: 'st.event.login_pending',
  password_changed: 'st.event.password_changed',
  password_reset: 'st.event.password_reset',
  password_reset_requested: 'st.event.password_reset_requested',
  mfa_enabled: 'st.event.mfa_enabled',
  mfa_disabled: 'st.event.mfa_disabled',
  sessions_revoked: 'st.event.sessions_revoked',
  session_revoked: 'st.event.session_revoked',
  account_created: 'st.event.account_created',
  email_verified: 'st.event.email_verified',
};

/** Login alerts and activity: recent sign-ins and changes to the account. */
export function Activity() {
  const c = useColors();
  const { t, timeAgo } = useT();
  const [items, setItems] = useState<{ type: string; ip: string | null; created_at: string }[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    void client()
      .then((api) => api.auth.securityEvents())
      .then(
        (r) => setItems(r.items),
        () => setItems([]),
      );
  }, []);
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.activity.desc')}>{t('st.activity.title')}</Title>
      {items === null ? (
        <Loading />
      ) : items.length ? (
        <>
          {(all ? items : items.slice(0, 6)).map((e, i) => (
            <View key={`${e.created_at}-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}>
              <Icon
                name={e.type === 'login_failed' ? 'warning-outline' : e.type.startsWith('login') ? 'key-outline' : 'shield-checkmark-outline'}
                size={20}
                color={e.type === 'login_failed' ? c.danger : c.inkMuted}
              />
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.ink, fontSize: 15, fontWeight: '600' }}>{t(EVENTS[e.type] ?? 'st.event.other')}</Text>
                <Text style={{ color: c.inkMuted, fontSize: 13 }}>{[timeAgo(e.created_at), e.ip].filter(Boolean).join(' · ')}</Text>
              </View>
            </View>
          ))}
          {items.length > 6 && !all ? <Button label={t('st.activity.more')} size="sm" variant="ghost" onPress={() => setAll(true)} /> : null}
        </>
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('st.activity.none')}</Text>
      )}
    </Card>
  );
}

/** Apps you allowed to use your account, each with Disconnect. */
export function ConnectedApps() {
  const c = useColors();
  const { t } = useT();
  const [items, setItems] = useState<{ id: string; name: string; scopes: string[] }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    void client()
      .then((api) => api.oauth.connectedApps())
      .then(
        (r) => setItems(r.items),
        (e) => (setItems([]), setError(errorMessage(e))),
      );
  }, []);
  useEffect(load, [load]);
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('settings.apps.subtitle')}>{t('settings.apps.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : items.length ? (
        items.map((a) => (
          <View key={a.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}>
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontSize: 15, fontWeight: '600' }, userText]}>{a.name}</Text>
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>{a.scopes.includes('write') ? t('settings.apps.readPost') : t('settings.apps.read')}</Text>
            </View>
            <Button
              label={t('settings.apps.disconnect')}
              size="sm"
              variant="secondary"
              onPress={async () => {
                try {
                  await (await client()).oauth.disconnect(a.id);
                  load();
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted }}>{t('settings.apps.none')}</Text>
      )}
    </Card>
  );
}

// ── Privacy and safety ──────────────────────────────────────────────────

/** Private account: only approved followers see your posts. */
export function PrivateAccount() {
  const { t } = useT();
  const { me } = useSession();
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!me) return;
    void client()
      .then((api) => api.users.get(me.username))
      .then(
        (r) => setOn(!!r.profile.isPrivate),
        (e) => setError(errorMessage(e)),
      );
  }, [me]);
  return (
    <Card style={{ gap: space[3] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {on === null ? (
        <Loading />
      ) : (
        <SwitchRow
          label={t('settings.private')}
          hint={t('settings.privateHint')}
          value={on}
          onValueChange={async (v) => {
            setOn(v);
            setError(null);
            try {
              await (await client()).me.updateProfile({ isPrivate: v });
            } catch (e) {
              setOn(!v);
              setError(errorMessage(e));
            }
          }}
        />
      )}
    </Card>
  );
}

/** Who can message, comment on and mention you. Friends always can. */
export function WhoCanReach() {
  const { t } = useT();
  const { settings, error, save } = useInteractions();
  return (
    <Card style={{ gap: space[4] }}>
      <Title sub={t('st.who.friendsAlways')}>{t('st.who.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <>
          <Choices
            label={t('st.who.message')}
            hint={t('st.who.messageHint')}
            value={settings.messagesFrom}
            onChange={(v) => void save({ messagesFrom: v })}
            options={[
              { id: 'everyone', label: t('st.who.everyone') },
              { id: 'following', label: t('st.who.following') },
              { id: 'friends', label: t('st.who.friends') },
            ]}
          />
          <Choices
            label={t('st.who.comment')}
            hint={t('st.who.commentHint')}
            value={settings.commentsFrom}
            onChange={(v) => void save({ commentsFrom: v })}
            options={[
              { id: 'everyone', label: t('st.who.everyone') },
              { id: 'following', label: t('st.who.following') },
              { id: 'followers', label: t('st.who.followers') },
            ]}
          />
          <Choices
            label={t('st.who.mention')}
            hint={t('st.who.mentionHint')}
            value={settings.mentionsFrom}
            onChange={(v) => void save({ mentionsFrom: v })}
            options={[
              { id: 'everyone', label: t('st.who.everyone') },
              { id: 'following', label: t('st.who.following') },
              { id: 'nobody', label: t('st.who.nobody') },
            ]}
          />
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

/** People you muted or restricted, each with a button to undo it. */
function PeopleList({
  title,
  sub,
  empty,
  undo,
  load,
  remove,
}: {
  title: string;
  sub?: string;
  empty: string;
  undo: string;
  load: () => Promise<{ items: PublicUser[] }>;
  remove: (id: string) => Promise<unknown>;
}) {
  const c = useColors();
  const [items, setItems] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current().then(
      (r) => setItems(r.items),
      (e) => (setItems([]), setError(errorMessage(e))),
    );
  }, []);
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={sub}>{title}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items === null ? (
        <Loading />
      ) : items.length ? (
        items.map((u) => (
          <View key={u.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 44 }}>
            <Avatar name={u.displayName} url={u.avatarUrl} size={36} />
            <View style={{ flex: 1 }}>
              <Text style={[{ color: c.ink, fontSize: 15, fontWeight: '600' }, userText]} numberOfLines={1}>
                {u.displayName}
              </Text>
              <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
                @{u.username}
              </Text>
            </View>
            <Button
              label={undo}
              size="sm"
              variant="secondary"
              onPress={async () => {
                setError(null);
                try {
                  await remove(u.id);
                  setItems((cur) => cur?.filter((x) => x.id !== u.id) ?? cur);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          </View>
        ))
      ) : (
        <Text style={{ color: c.inkMuted }}>{empty}</Text>
      )}
    </Card>
  );
}

export function MutedAccounts() {
  const { t } = useT();
  return (
    <PeopleList
      title={t('st.muted.title')}
      sub={t('st.muted.desc')}
      empty={t('st.muted.none')}
      undo={t('m.profile.unmute')}
      load={async () => (await client()).me.muted()}
      remove={async (id) => (await client()).users.unmute(id)}
    />
  );
}

export function RestrictedAccounts() {
  const { t } = useT();
  return (
    <PeopleList
      title={t('st.restricted.title')}
      sub={t('st.restricted.desc')}
      empty={t('st.restricted.none')}
      undo={t('st.restricted.undo')}
      load={async () => (await client()).me.restricted()}
      remove={async (id) => (await client()).users.unrestrict(id)}
    />
  );
}

/** Sensitive photos and videos: covered until you choose to see them, or not shown at all. */
export function SensitiveContent() {
  const { t } = useT();
  const { settings, error, save } = useInteractions();
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.sensitive.desc')}>{t('st.sensitive.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <Choices
          label={t('st.sensitive.title')}
          value={settings.sensitiveMedia}
          disabled={settings.sensitiveLocked}
          hint={settings.sensitiveLocked ? t('st.sensitive.locked') : undefined}
          onChange={(v) => void save({ sensitiveMedia: v })}
          options={[
            { id: 'standard', label: t('st.sensitive.standard'), hint: t('st.sensitive.standardHint') },
            { id: 'less', label: t('st.sensitive.less'), hint: t('st.sensitive.lessHint') },
          ]}
        />
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

// ── Notifications ───────────────────────────────────────────────────────

/** Notifications on this phone. */
export function PushOnThisPhone() {
  const c = useColors();
  const { t } = useT();
  const [note, setNote] = useState<string | null>(null);
  return (
    <Card style={{ gap: space[3] }}>
      <Text style={{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }}>{t('st.push.phone')}</Text>
      <Button
        label={t('m.push.enable')}
        icon="notifications-outline"
        variant="secondary"
        onPress={async () => {
          const r = await registerForPush().catch(() => 'unavailable' as const);
          setNote(r === 'registered' ? t('m.push.on') : r === 'denied' ? t('m.push.blocked') : t('m.push.unavailable'));
        }}
      />
      {note ? <Notice>{note}</Notice> : null}
    </Card>
  );
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** Quiet hours: phone notifications wait until they end, every day, in your time zone. */
export function QuietHours() {
  const c = useColors();
  const { t } = useT();
  const { settings, error, save } = useInteractions();
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [saved, setSaved] = useState(false);
  const seeded = useRef(false);
  useEffect(() => {
    if (!settings?.quietHours || seeded.current) return;
    seeded.current = true;
    setStart(settings.quietHours.start);
    setEnd(settings.quietHours.end);
  }, [settings]);
  const valid = HHMM.test(start) && HHMM.test(end) && start !== end;
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.quiet.desc')}>{t('st.quiet.title')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {settings ? (
        <>
          <SwitchRow
            label={t('st.quiet.switch')}
            value={!!settings.quietHours}
            onValueChange={(v) => void save({ quietHours: v ? { start, end, timezone: zone() } : null })}
          />
          {settings.quietHours ? (
            <>
              <View style={{ flexDirection: 'row', gap: space[2] }}>
                <View style={{ flex: 1 }}>
                  <Field
                    label={t('st.quiet.from')}
                    placeholder="22:00"
                    keyboardType="numbers-and-punctuation"
                    value={start}
                    onChangeText={(v) => setStart(v.trim())}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Field
                    label={t('st.quiet.until')}
                    placeholder="07:00"
                    keyboardType="numbers-and-punctuation"
                    value={end}
                    onChangeText={(v) => setEnd(v.trim())}
                  />
                </View>
              </View>
              {!valid ? <Text style={{ color: c.danger, fontSize: 13 }}>{t('m.family.quietInvalid')}</Text> : null}
              <Text style={{ color: c.inkMuted, fontSize: 13 }}>{t('st.quiet.zone', { zone: settings.quietHours.timezone })}</Text>
              {saved ? <Text style={{ color: c.success, fontSize: 13 }}>{t('st.quiet.saved')}</Text> : null}
              <Button
                label={t('common.save')}
                size="sm"
                variant="secondary"
                disabled={!valid}
                style={{ alignSelf: 'flex-start' }}
                onPress={async () => setSaved(await save({ quietHours: { start, end, timezone: zone() } }))}
              />
            </>
          ) : null}
        </>
      ) : !error ? (
        <Loading />
      ) : null}
    </Card>
  );
}

// ── Language, appearance, help ──────────────────────────────────────────

/** The app's language, from the languages YAPILAPI speaks. */
export function AppLanguage() {
  const c = useColors();
  const { t, lang } = useT();
  const { me, refresh } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const current = me?.locale ?? lang;
  return (
    <Card style={{ gap: space[2] }}>
      <Title sub={t('st.language.appHint')}>{t('settings.language')}</Title>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <View accessibilityRole="radiogroup" accessibilityLabel={t('settings.language')}>
        {SUPPORTED_LOCALES.map((l) => {
          const on = current === l;
          const name = new Intl.DisplayNames([l], { type: 'language' }).of(l) ?? l;
          return (
            <Pressable
              key={l}
              accessibilityRole="radio"
              accessibilityState={{ checked: on, busy: busy === l }}
              accessibilityLanguage={l}
              disabled={!!busy}
              onPress={async () => {
                if (on) return;
                setBusy(l);
                setError(null);
                try {
                  await (await client()).me.updateProfile({ locale: l });
                  await refresh();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(null);
                }
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: space[3], minHeight: 48 }}
            >
              <Icon name={on ? 'radio-button-on' : 'radio-button-off'} size={22} color={on ? c.yapi : c.inkMuted} />
              <Text style={{ color: c.ink, fontSize: 16, fontWeight: on ? '700' : '500', flex: 1, textTransform: 'capitalize' }}>{name}</Text>
              {busy === l ? <Loading /> : null}
            </Pressable>
          );
        })}
      </View>
    </Card>
  );
}

export function AppearanceCard() {
  const { t } = useT();
  const [appearance, setAppearance] = useAppearance();
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.appearance.hint')}>{t('st.appearance.theme')}</Title>
      <AppearanceSegments value={appearance} onChange={(v) => void setAppearance(v)} />
    </Card>
  );
}

/** Report a problem: what happened, with the app version. */
export function ReportProblem() {
  const { t } = useT();
  const [body, setBody] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card style={{ gap: space[3] }}>
      <Title sub={t('st.problem.desc')}>{t('st.problem.title')}</Title>
      {sent ? (
        <>
          <Notice>{t('st.problem.sent')}</Notice>
          <Button label={t('st.problem.another')} size="sm" variant="ghost" style={{ alignSelf: 'flex-start' }} onPress={() => (setSent(false), setBody(''))} />
        </>
      ) : (
        <>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Field
            label={t('st.problem.label')}
            value={body}
            onChangeText={setBody}
            multiline
            maxLength={2000}
            style={{ minHeight: 110, textAlignVertical: 'top' }}
          />
          <Button
            label={t('st.problem.send')}
            disabled={body.trim().length < 5}
            onPress={async () => {
              setError(null);
              try {
                await (
                  await client()
                ).me.reportProblem({
                  body: body.trim(),
                  platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'other',
                  appVersion: APP_VERSION,
                });
                setSent(true);
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          />
        </>
      )}
    </Card>
  );
}

export function LegalLinks() {
  const { t } = useT();
  return (
    <SettingsGroup title={t('legal.title')}>
      {LEGAL_DOCS.map((d) => (
        <SettingsLinkRow key={d.slug} icon="document-text-outline" title={t(d.title)} desc={t(d.summary)} external onPress={() => void openLegal(d.slug)} />
      ))}
    </SettingsGroup>
  );
}

export function About() {
  const c = useColors();
  const { t } = useT();
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
      <View style={{ width: 44, height: 44, borderRadius: 14, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="sparkles" size={22} color={c.yapi} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{Platform.OS === 'ios' ? t('st.about.ios') : t('st.about.android')}</Text>
        <Text style={{ color: c.inkMuted, fontSize: 13 }}>
          {t('st.about.version', { version: APP_VERSION })} · {t('app.tagline')}
        </Text>
      </View>
    </Card>
  );
}

/** A row to another screen (close friends, circles, archive, Plus). */
export function LinkRow({ icon, title, desc, href }: { icon: IconName; title: string; desc?: string; href: Href }) {
  return <SettingsLinkRow icon={icon} title={title} desc={desc} onPress={() => router.push(href)} />;
}
