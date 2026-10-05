import { router, type Href } from 'expo-router';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { MAX_ACCOUNTS, type StoredAccount } from './api';
import { useAppearance, type AppearanceChoice } from './appearance';
import { useT } from './i18n';
import { useSession } from './session';
import { radius, space } from './theme';
import { Avatar, BottomSheet, Icon, Segmented, SheetItem, useColors, userText, type IconName } from './ui';

/**
 * The account menu: who you are and the other accounts signed in on this phone (tap one to
 * switch), Add account, then View profile, Settings, Saved, Drafts, Appearance, Language, Help and
 * legal, and Log out. It opens from the You tab's header, and from a long press on the You tab.
 */

type Ctx = { open: () => void };
const AccountMenuCtx = createContext<Ctx>({ open: () => {} });
export const useAccountMenu = () => useContext(AccountMenuCtx);

/** After switching or logging out into another account: close everything and start at Pulse. */
export function goHome() {
  if (router.canDismiss()) router.dismissAll();
  router.replace('/');
}

/** "Log out of YAPILAPI?", then log out; another signed-in account takes over when there is one. */
export function useConfirmLogout() {
  const { t } = useT();
  const { signOut, me } = useSession();
  return useCallback(() => {
    Alert.alert(t('acct.logout.title'), me ? t('acct.logout.bodyAccount', { username: me.username }) : t('acct.logout.body'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('auth.logout'),
        style: 'destructive',
        onPress: async () => {
          // Signed out completely: the root layout opens the welcome screen by itself.
          if ((await signOut()) === 'switched') goHome();
        },
      },
    ]);
  }, [t, signOut, me]);
}

/** Switch to another account signed in on this phone; when its session has ended, log in again. */
export function useSwitchAccount() {
  const { t } = useT();
  const { switchAccount } = useSession();
  return useCallback(
    async (a: StoredAccount) => {
      const r = await switchAccount(a.id);
      if (r === 'ok') return goHome();
      // Offline, or a problem on our side: the account is still here; say so rather than that it was logged out.
      if (r === 'unavailable') return Alert.alert(t('error.network'));
      Alert.alert(t('acct.expired.title'), t('acct.expired.body', { username: a.username }), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('auth.login.submit'), onPress: () => router.push({ pathname: '/login', params: { add: '1' } }) },
      ]);
    },
    [t, switchAccount],
  );
}

export function AccountMenuProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const value = useMemo(() => ({ open: () => setVisible(true) }), []);
  return (
    <AccountMenuCtx.Provider value={value}>
      {children}
      <AccountMenuSheet visible={visible} onClose={() => setVisible(false)} />
    </AccountMenuCtx.Provider>
  );
}

function AccountRow({ account, current, onPress, onLogout }: { account: StoredAccount; current?: boolean; onPress?: () => void; onLogout?: () => void }) {
  const c = useColors();
  const { t } = useT();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
      <Pressable
        accessibilityRole={current ? undefined : 'button'}
        accessibilityLabel={current ? `${account.displayName}, @${account.username}, ${t('acct.current')}` : t('acct.switchTo', { username: account.username })}
        disabled={current}
        onPress={onPress}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space[3],
          minHeight: 56,
          paddingHorizontal: space[2],
          borderRadius: radius.md,
          backgroundColor: pressed ? c.surfaceSunken : 'transparent',
        })}
      >
        <Avatar name={account.displayName} url={account.avatarUrl} size={current ? 48 : 40} />
        <View style={{ flex: 1 }}>
          <Text style={[{ color: c.ink, fontSize: current ? 17 : 15, fontWeight: '700' }, userText]} numberOfLines={1}>
            {account.displayName}
          </Text>
          <Text style={{ color: c.inkMuted, fontSize: 13 }} numberOfLines={1}>
            @{account.username}
          </Text>
        </View>
        {current ? <Icon name="checkmark-circle" size={22} color={c.yapi} /> : null}
      </Pressable>
      {onLogout ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('acct.logoutOne', { username: account.username })}
          hitSlop={6}
          onPress={onLogout}
          style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon name="log-out-outline" size={20} color={c.inkMuted} directional />
        </Pressable>
      ) : null}
    </View>
  );
}

function AccountMenuSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const { t } = useT();
  const { me, accounts, removeAccount } = useSession();
  const [appearance, setAppearance] = useAppearance();
  const confirmLogout = useConfirmLogout();
  const switchTo = useSwitchAccount();
  if (!me) return null;
  const others = accounts.filter((a) => a.id !== me.id);
  const full = accounts.length >= MAX_ACCOUNTS;
  // Close first, then act: iOS can't show an alert or push a screen over a sheet that is closing.
  const after = (fn: () => void) => {
    onClose();
    setTimeout(fn, 350);
  };
  const go = (href: Href) => after(() => router.push(href));
  const items: { icon: IconName; label: string; href: Href }[] = [
    { icon: 'person-circle-outline', label: t('acct.viewProfile'), href: '/profile' },
    { icon: 'settings-outline', label: t('settings.title'), href: '/settings' },
    { icon: 'bookmark-outline', label: t('m.saved.title'), href: '/saved' },
    { icon: 'document-text-outline', label: t('m.drafts.title'), href: '/drafts' },
  ];
  return (
    <BottomSheet visible={visible} title={t('acct.menu')} onClose={onClose} maxHeight="90%">
      <View style={{ gap: space[1] }}>
        <AccountRow account={{ id: me.id, username: me.username, displayName: me.displayName, avatarUrl: me.avatarUrl ?? null }} current />
        {others.map((a) => (
          <AccountRow
            key={a.id}
            account={a}
            onPress={() => after(() => void switchTo(a))}
            onLogout={() =>
              after(() =>
                Alert.alert(t('acct.logoutOne', { username: a.username }), t('acct.logoutOne.body'), [
                  { text: t('common.cancel'), style: 'cancel' },
                  { text: t('auth.logout'), style: 'destructive', onPress: () => void removeAccount(a.id) },
                ]),
              )
            }
          />
        ))}
        <SheetItem
          icon="person-add-outline"
          label={t('acct.add')}
          hint={full ? t('acct.max', { count: MAX_ACCOUNTS }) : t('acct.addHint')}
          disabled={full}
          onPress={() => go({ pathname: '/login', params: { add: '1' } })}
        />
        {full ? <Text style={{ color: c.inkMuted, fontSize: 13, paddingHorizontal: space[2] }}>{t('acct.max', { count: MAX_ACCOUNTS })}</Text> : null}
      </View>
      <View style={{ height: 1, backgroundColor: c.line }} />
      <View style={{ gap: 2 }}>
        {items.map((i) => (
          <SheetItem key={i.label} icon={i.icon} label={i.label} onPress={() => go(i.href)} />
        ))}
      </View>
      <View style={{ gap: space[2] }}>
        <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' }}>{t('st.appearance.title')}</Text>
        <AppearanceSegments value={appearance} onChange={(v) => void setAppearance(v)} />
      </View>
      <View style={{ gap: 2 }}>
        <SheetItem icon="language-outline" label={t('settings.language')} onPress={() => go('/settings/language')} />
        <SheetItem icon="help-circle-outline" label={t('st.help.title')} onPress={() => go('/settings/help')} />
        <SheetItem icon="log-out-outline" label={t('auth.logout')} danger onPress={() => after(confirmLogout)} />
      </View>
    </BottomSheet>
  );
}

/** Light, Dark or Match device; applied app-wide the moment it's picked. */
export function AppearanceSegments({ value, onChange }: { value: AppearanceChoice; onChange: (v: AppearanceChoice) => void }) {
  const { t } = useT();
  return (
    <Segmented
      label={t('st.appearance.title')}
      value={value}
      onChange={onChange}
      options={[
        { id: 'light', label: t('st.appearance.light') },
        { id: 'dark', label: t('st.appearance.dark') },
        { id: 'system', label: t('st.appearance.system') },
      ]}
    />
  );
}

/** The You tab's header: Settings (a gear) and the account menu. */
export function YouHeaderActions() {
  const c = useColors();
  const { t } = useT();
  const menu = useAccountMenu();
  return (
    <View style={{ flexDirection: 'row', gap: space[1], marginEnd: space[2] }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('settings.title')}
        hitSlop={6}
        onPress={() => router.push('/settings')}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="settings-outline" size={24} color={c.ink} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('acct.menu')}
        hitSlop={6}
        onPress={menu.open}
        style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name="menu-outline" size={26} color={c.ink} />
      </Pressable>
    </View>
  );
}

/** The You tab's title: your @username; tapping it opens the account menu (to switch accounts). */
export function YouHeaderTitle() {
  const c = useColors();
  const { t } = useT();
  const { me } = useSession();
  const menu = useAccountMenu();
  if (!me) return <Text style={{ color: c.ink, fontSize: 18, fontWeight: '800' }}>{t('nav.profile')}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('acct.switchA11y', { username: me.username })}
      onPress={menu.open}
      hitSlop={8}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 220 }}
    >
      <Text style={[{ color: c.ink, fontSize: 18, fontWeight: '800' }, userText]} numberOfLines={1}>
        @{me.username}
      </Text>
      <Icon name="chevron-down" size={16} color={c.ink} />
    </Pressable>
  );
}
