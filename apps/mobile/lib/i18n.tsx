import { reloadAppAsync } from 'expo';
import { useLocales } from 'expo-localization';
import * as SecureStore from 'expo-secure-store';
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { DevSettings, I18nManager } from 'react-native';
import { currentTranslator, resolveLocale, setCurrentLocale, type Translator } from './locale';
import { useSession } from './session';

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
  useEffect(() => {
    if (settled) void applyDirection(value.rtl);
  }, [settled, value.rtl]);

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
 * - When the running direction differs, reload once with `reloadAppAsync` from `expo` (works in
 *   development and release builds; there is no expo-updates here), falling back to
 *   `DevSettings.reload()` in development.
 * - If the direction still differs after that reload (a host that ignores forceRTL, such as
 *   Expo Go on some versions), don't reload again: it applies on the next cold start.
 */
async function applyDirection(rtl: boolean) {
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
  if (I18nManager.isRTL === rtl) {
    await SecureStore.deleteItemAsync(RELOAD_KEY).catch(() => {});
    return;
  }
  const want = rtl ? 'rtl' : 'ltr';
  if ((await SecureStore.getItemAsync(RELOAD_KEY).catch(() => null)) === want) return;
  await SecureStore.setItemAsync(RELOAD_KEY, want).catch(() => {});
  try {
    await reloadAppAsync('Layout direction changed');
  } catch {
    if (__DEV__) DevSettings.reload();
  }
}
