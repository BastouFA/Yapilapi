import { router, Stack, useGlobalSearchParams, usePathname } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { useT } from '../../mobile/lib/i18n';
import { EmptyState, useColors } from '../../mobile/lib/ui';
import { openInYapilapi } from '../lib/elsewhere';

/**
 * Every screen Yap doesn't have (a post, a profile, a story, a community, which the phone app's
 * shared chat code links to) lands here: it opens in YAPILAPI, or on the web when YAPILAPI isn't on
 * this phone, and Yap goes back to where you were. If that couldn't open, it says so with a button.
 */
export default function Elsewhere() {
  const c = useColors();
  const { t } = useT();
  const path = usePathname();
  const params = useGlobalSearchParams();
  const query = Object.entries(params)
    .filter((e): e is [string, string] => !e[0].startsWith('+') && typeof e[1] === 'string')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const target = `${path}${query ? `?${query}` : ''}`;
  const tried = useRef(false);

  const leave = useCallback(() => (router.canGoBack() ? router.back() : router.replace('/')), []);
  const open = useCallback(
    () =>
      openInYapilapi(target).then(
        () => leave(),
        () => {},
      ),
    [target, leave],
  );

  useEffect(() => {
    if (tried.current || !path || path === '/') return;
    tried.current = true;
    void open();
  }, [path, open]);

  return (
    <View style={{ flex: 1, backgroundColor: c.ground, justifyContent: 'center' }}>
      <Stack.Screen options={{ title: '', animation: 'none' }} />
      <EmptyState
        icon="open-outline"
        title={t('yapApp.elsewhere.title')}
        body={t('yapApp.elsewhere.body')}
        action={{ label: t('yapMode.backToApp'), icon: 'open-outline', onPress: () => void open() }}
        secondary={{ label: t('m.common.back'), onPress: leave }}
      />
    </View>
  );
}
