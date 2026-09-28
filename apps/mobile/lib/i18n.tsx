import { reloadAppAsync } from 'expo';
import { useLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, DevSettings, I18nManager, useColorScheme, View } from 'react-native';
import { currentTranslator, resolveLocale, setCurrentLocale, type Translator } from './locale';
import { useSession } from './session';
import { palette } from './theme';

export type { Translate, Translator } from './locale';

const Ctx = createContext<Translator>(currentTranslator());

/**
 * `const { t, tp, locale, dateTime, timeAgo } = useT()`. Components that call it re-render when
 * the language changes.
 */
export const useT = () => useContext(Ctx);

/**
 * The app's language: the signed-in person's `locale` when it has a catalog, then the phone's
 * languages in order of preference (expo-localization, which also follows the per-app language
 * setting on iOS and Android 13+), then English.
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const { me } = useSession();
  const device = useLocales();
  const deviceTags = device.map((l) => l.languageTag).join(',');
  const value = useMemo(() => setCurrentLocale(resolveLocale([me?.locale, ...deviceTags.split(',')])), [me?.locale, deviceTags]);

  // Wait until we know who is signed in, so a person whose language differs from the phone's
  // doesn't cause two reloads at start-up.
  const settled = me !== undefined;
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    if (!settled) return;
    let live = true;
    void needsDirectionReload(value.rtl).then((reload) => live && reload && setSwitching(true));
    return () => {
      live = false;
    };
  }, [settled, value.rtl]);

  // The screens are gone before the reload: a playing video, audio or a location watch still
  // running can stop React Native from finishing it, which froze the app.
  useEffect(() => {
    if (!switching) return;
    const timer = setTimeout(() => void reloadForDirection(), 400);
    return () => clearTimeout(timer);
  }, [switching]);

  const c = palette(useColorScheme() === 'dark' ? 'dark' : 'light');
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
