import { reloadAppAsync } from 'expo';
import { useLocales } from 'expo-localization';
import { SplashScreen } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, DevSettings, I18nManager, useColorScheme, View } from 'react-native';
import { loadLocale } from '../../../packages/shared/src/i18n-core';
import { currentTranslator, resolveLocale, setCurrentLocale, type LocaleInfo, type Translator } from './locale';
import { useSession } from './session';
import { palette } from './theme';

export type { Translate, Translator } from './locale';

// The splash screen stays up until the reader's language is loaded (LocaleProvider hides it), so
// the first screen doesn't flash English.
void SplashScreen.preventAutoHideAsync().catch(() => {});

const Ctx = createContext<Translator>(currentTranslator());

/**
 * `const { t, tp, locale, dateTime, timeAgo } = useT()`. Components that call it re-render when
 * the language changes.
 */
export const useT = () => useContext(Ctx);

/** The language this phone showed last, read at start-up before anyone is signed in. */
const LANGUAGE_KEY = 'ypl_language';

/**
 * The app's language: the signed-in person's `locale` when it has a catalog, then the phone's
 * languages in order of preference (expo-localization, which also follows the per-app language
 * setting on iOS and Android 13+), then English.
 *
 * Only English is in memory from the start; the language to show is loaded (loadLocale) before
 * the screens draw, with the splash screen up, and again when it changes, the old one staying on
 * screen meanwhile. Until the session says who is signed in, the language shown last time stands
 * in for theirs, so a start-up loads one catalog, not the phone's and then the account's.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const device = useLocales();
  const deviceTags = device.map((l) => l.languageTag).join(',');

  const [last, setLast] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    SecureStore.getItemAsync(LANGUAGE_KEY).then(
      (v) => live && setLast(v),
      () => live && setLast(null),
    );
    // Never keep the splash screen up waiting on the keychain.
    const timer = setTimeout(() => live && setLast((v) => (v === undefined ? null : v)), 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  // undefined while the session is loading, null for nobody signed in or no language saved.
  const account = me === undefined ? undefined : (me?.locale ?? null);
  const wanted = useMemo(
    () => (account === undefined && last === undefined ? null : resolveLocale([account === undefined ? last : account, ...deviceTags.split(',')])),
    [account, last, deviceTags],
  );

  const [shown, setShown] = useState<LocaleInfo | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    // At once when it's already loaded (English, or shown before). If it can't be loaded, t() reads English.
    void loadLocale(wanted.lang).then(() => live && setShown(wanted));
    return () => {
      live = false;
    };
  }, [wanted]);
  const value = useMemo(() => (shown ? setCurrentLocale(shown) : null), [shown]);

  useEffect(() => {
    if (!shown) return;
    void SplashScreen.hideAsync().catch(() => {});
    void SecureStore.setItemAsync(LANGUAGE_KEY, shown.locale).catch(() => {});
  }, [shown]);

  // Wait until we know who is signed in and their language is on screen, so a person whose
  // language differs from the phone's doesn't cause two reloads at start-up.
  const settled = account !== undefined && !!shown && shown === wanted;
  const rtl = shown?.rtl ?? false;
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!settled) return;
    let live = true;
    void needsDirectionReload(rtl).then((reload) => live && reload && setSwitching(true));
    return () => {
      live = false;
    };
  }, [settled, rtl]);

  // The screens are gone before the reload: a playing video, audio or a location watch still
  // running can stop React Native from finishing it, which froze the app.
  useEffect(() => {
    if (!switching) return;
    const timer = setTimeout(() => void reloadForDirection(), 400);
    return () => clearTimeout(timer);
  }, [switching]);

  const c = palette(useColorScheme() === 'dark' ? 'dark' : 'light');
  // The splash screen is still up.
  if (!value) return null;
  if (switching)
    return (
      <View accessibilityLabel={value.t('common.loading')} style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.ground }}>
        <ActivityIndicator color={c.yapi} />
      </View>
    );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const RELOAD_KEY = 'ypl_direction_reload';

/**
 * Right-to-left layout. React Native reads the direction once, when the JavaScript starts, so
 * `forceRTL` only takes effect after a reload. The flag is persisted natively, so later cold
 * starts open in the right direction with no reload.
 *
 * - RTL language: allowRTL(true) + forceRTL(true). LTR language: allowRTL(false) +
 *   forceRTL(false), so a phone set to Arabic doesn't mirror an app showing English.
 * - When the running direction differs, the screens are taken down first, then the app reloads
 *   once with `reloadAppAsync` from `expo` (works in development and release builds; there is no
 *   expo-updates here), falling back to `DevSettings.reload()` in development.
 * - If the direction still differs after that reload (a host that ignores forceRTL, such as
 *   Expo Go on some versions), don't reload again: it applies on the next cold start.
 * - Known limit: after that reload, the native back arrow in iOS headers keeps the old direction
 *   until the app is next opened (react-native-screens sets it through UIAppearance, once per
 *   process). Everything else, including the layout and swipe-back, switches straight away.
 */
async function needsDirectionReload(rtl: boolean): Promise<boolean> {
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  if (I18nManager.isRTL === rtl) {
    await SecureStore.deleteItemAsync(RELOAD_KEY).catch(() => {});
    return false;
  }
  const want = rtl ? 'rtl' : 'ltr';
  if ((await SecureStore.getItemAsync(RELOAD_KEY).catch(() => null)) === want) return false;
  await SecureStore.setItemAsync(RELOAD_KEY, want).catch(() => {});
  return true;
}

async function reloadForDirection() {
  try {
    await reloadAppAsync('Layout direction changed');
  } catch {
    if (__DEV__) DevSettings.reload();
  }
}
