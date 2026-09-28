import { router, Stack, usePathname } from 'expo-router';
import { View } from 'react-native';
import { useT } from '../lib/i18n';
import { openOnWeb } from '../lib/money';
import { EmptyState, useColors } from '../lib/ui';

/**
 * A link the app has no screen for (a web-only page, an old or mistyped link): say so plainly, with
 * a way to Pulse and a way to the same page on the web, instead of the router's developer page.
 */
export default function NotFound() {
  const c = useColors();
  const { t } = useT();
  const path = usePathname();
  return (
    <View style={{ flex: 1, backgroundColor: c.ground, justifyContent: 'center' }}>
      <Stack.Screen options={{ title: '' }} />
      <EmptyState
        icon="compass-outline"
        title={t('m.notFound.title')}
        body={t('m.notFound.body')}
        action={{ label: t('m.notFound.home'), icon: 'home-outline', onPress: () => router.replace('/') }}
        secondary={path && path !== '/' ? { label: t('m.notFound.web'), icon: 'open-outline', onPress: () => void openOnWeb(path).catch(() => {}) } : undefined}
      />
    </View>
  );
}
