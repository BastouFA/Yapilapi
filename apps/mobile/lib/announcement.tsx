import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import type { Announcement } from '../../../packages/api-client/src/index';
import { client, webUrl } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Card, Icon, slop, useColors, userText } from './ui';

/**
 * A note from the team to everyone (written in the admin console), at the top of Pulse until it
 * ends or you close it. Shown as written, not translated. A link to a page of the app opens on the
 * web, which hands app pages back to the app.
 */
export function AnnouncementCard() {
  const c = useColors();
  const { t } = useT();
  const [a, setA] = useState<Announcement | null>(null);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void (async () => {
        try {
          const r = await (await client()).announcements.current();
          if (live) setA(r.announcement);
        } catch {
          // A note that can't load is simply not shown.
        }
      })();
      return () => {
        live = false;
      };
    }, []),
  );
  if (!a) return null;
  const link = a.linkUrl ? (a.linkUrl.startsWith('/') ? `${webUrl}${a.linkUrl}` : a.linkUrl) : null;
  return (
    <Card style={{ borderStartWidth: 4, borderStartColor: c.saffron, padding: space[3], gap: space[1] }}>
      <View accessibilityRole="summary" accessibilityLabel={t('announcement.label')} style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start' }}>
        <Icon name="information-circle-outline" size={20} color={c.inkMuted} />
        <View style={{ flex: 1, gap: space[1] }}>
          <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 15 }, userText]}>{a.title}</Text>
          <Text style={[{ color: c.ink, lineHeight: 20 }, userText]}>{a.body}</Text>
          {link ? (
            <Pressable accessibilityRole="link" hitSlop={slop({ top: 12, bottom: 12, end: 12 })} onPress={() => void Linking.openURL(link).catch(() => {})}>
              <Text style={{ color: c.yapi, fontWeight: '700', textDecorationLine: 'underline' }}>{t('announcement.more')}</Text>
            </Pressable>
          ) : null}
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('announcement.close')}
          hitSlop={slop({ top: 12, bottom: 12, start: 12, end: 12 })}
          style={{ borderRadius: radius.sm, padding: 2 }}
          onPress={() => {
            const id = a.id;
            setA(null);
            void (async () => {
              try {
                await (await client()).announcements.dismiss(id);
              } catch {
                // Closed here either way; it may show again next time.
              }
            })();
          }}
        >
          <Icon name="close" size={20} color={c.inkMuted} />
        </Pressable>
      </View>
    </Card>
  );
}
