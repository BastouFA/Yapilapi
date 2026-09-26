import { useEffect, useState } from 'react';
import { Image, Linking, Text, View } from 'react-native';
import type { ShopItem } from '../../../packages/api-client/src/index';
import { formatMoney } from '../../../packages/shared/src/i18n';
import type { Post } from '../../../packages/shared/src/types';
import { client, errorMessage, webUrl } from './api';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Button, Card, EmptyState, Icon, Loading, Notice, useColors, userText } from './ui';

/** Payments happen on the web app (checkout isn't in the phone app yet): open a page there. */
export const openOnWeb = (path: string) => Linking.openURL(`${webUrl}${path}`);

/** Only tiny inline previews the API sends for locked posts; never a remote URL. */
const isInlinePreview = (s: string | null | undefined): s is string => !!s && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(s);

/**
 * A post for subscribers, seen by someone who isn't one: a blurred preview,
 * who it's from, and a way to subscribe (on the web, where checkout is).
 */
export function LockedPanel({ post, dark }: { post: Post; dark?: boolean }) {
  const c = useColors();
  const { t } = useT();
  const preview = post.locked?.placeholder;
  const fg = dark ? '#FFFFFF' : c.ink;
  const muted = dark ? '#C9CDE0' : c.inkMuted;
  return (
    <View
      style={{
        borderRadius: dark ? 0 : radius.md,
        overflow: 'hidden',
        backgroundColor: dark ? '#10121E' : c.surfaceSunken,
        minHeight: isInlinePreview(preview) ? 220 : undefined,
        justifyContent: 'center',
        flex: dark ? 1 : undefined,
      }}
    >
      {isInlinePreview(preview) ? (
        <Image source={{ uri: preview }} blurRadius={20} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      ) : null}
      {isInlinePreview(preview) ? (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#00000080' : '#00000040' }} />
      ) : null}
      <View style={{ alignItems: 'center', gap: space[2], padding: space[6] }}>
        <Icon name="lock-closed" size={26} color={isInlinePreview(preview) ? '#FFFFFF' : fg} />
        <Text style={{ color: isInlinePreview(preview) ? '#FFFFFF' : fg, fontWeight: '800', fontSize: 16 }}>{t('post.locked.title')}</Text>
        <Text style={[{ color: isInlinePreview(preview) ? '#E6E8F2' : muted, textAlign: 'center' }, userText]}>
          {t('post.locked.body', { name: post.author.displayName })}
        </Text>
        <Button label={t('post.locked.cta')} size="sm" onPress={() => void openOnWeb(`/u/${post.author.username}?subscribe=1`)} />
        <Text style={{ color: isInlinePreview(preview) ? '#E6E8F2' : muted, fontSize: 12 }}>{t('m.shop.onWeb')}</Text>
      </View>
    </View>
  );
}

/** A profile's Shop tab: what they sell. Buying and booking open checkout on the web; your downloads open from here. */
export function ShopList({ userId, username, isSelf }: { userId: string; username: string; isSelf: boolean }) {
  const c = useColors();
  const { t, locale } = useT();
  const [items, setItems] = useState<ShopItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        setItems((await (await client()).shop.list(userId)).items);
      } catch {
        setItems([]);
      }
    })();
  }, [userId]);

  if (items === null) return <Loading />;
  if (!items.length) return <EmptyState title={t('m.shop.empty')} />;
  return (
    <View style={{ gap: space[3] }}>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {items.map((p) => (
        <Card key={p.id} style={{ gap: space[2] }}>
          <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]}>{p.title}</Text>
          {p.kind === 'digital' || p.kind === 'service' ? (
            <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }}>{p.kind === 'digital' ? t('m.shop.digital') : t('m.shop.service')}</Text>
          ) : null}
          {p.description ? (
            <Text style={[{ color: c.inkMuted, fontSize: 14 }, userText]} numberOfLines={4}>
              {p.description}
            </Text>
          ) : null}
          <Text style={{ color: c.ink, fontWeight: '700' }}>{formatMoney(p.priceCents, p.currency, locale)}</Text>
          {isSelf ? null : p.kind === 'digital' && p.owned ? (
            <Button
              label={t('m.shop.download')}
              icon="download-outline"
              size="sm"
              onPress={async () => {
                setError(null);
                try {
                  const { url } = await (await client()).shop.download(p.id);
                  await Linking.openURL(url);
                } catch (e) {
                  setError(errorMessage(e));
                }
              }}
            />
          ) : (
            <>
              <Button
                label={p.kind === 'service' ? t('m.shop.book') : t('m.shop.buy')}
                size="sm"
                variant="secondary"
                onPress={() => void openOnWeb(`/u/${username}?shop=1`)}
              />
              <Text style={{ color: c.inkMuted, fontSize: 12 }}>{t('m.shop.onWeb')}</Text>
            </>
          )}
        </Card>
      ))}
    </View>
  );
}
