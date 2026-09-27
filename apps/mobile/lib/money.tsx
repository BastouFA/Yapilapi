import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, Linking, Pressable, Text, View } from 'react-native';
import type { ShopItem } from '../../../packages/api-client/src/index';
import { formatBytes } from '../../../packages/shared/src/data-saver';
import { formatMoney } from '../../../packages/shared/src/i18n';
import type { Post } from '../../../packages/shared/src/types';
import { client, webUrl } from './api';
import { useFlag } from './flags';
import { useT } from './i18n';
import { radius, space } from './theme';
import { Button, Card, EmptyState, Icon, Loading, useColors, userText } from './ui';

/**
 * Payments happen on the web app: the phone app has no checkout and never sees card details.
 * This opens a page there in the browser.
 */
export const openOnWeb = (path: string) => Linking.openURL(`${webUrl}${path}`);

/**
 * Open a web page for checkout and, when the person comes back to the app, call `onBack` (to
 * show what they bought, their subscription or their boost). Returns the opener and whether a
 * page was opened, for an "after paying, come back here" note.
 */
export function useWebCheckout(onBack: () => void) {
  const [opened, setOpened] = useState(false);
  const waiting = useRef(false);
  const back = useRef(onBack);
  back.current = onBack;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active' && waiting.current) {
        waiting.current = false;
        back.current();
      }
    });
    return () => sub.remove();
  }, []);
  const open = useCallback((path: string) => {
    waiting.current = true;
    setOpened(true);
    void openOnWeb(path);
  }, []);
  return { open, opened };
}

/** Web pages the phone app opens for checkout (apps/web handles each query). */
export const webCheckout = {
  subscribe: (username: string) => `/u/${encodeURIComponent(username)}?subscribe=1`,
  tip: (username: string, postId?: string) => `/u/${encodeURIComponent(username)}?tip=1${postId ? `&post=${encodeURIComponent(postId)}` : ''}`,
  product: (username: string, productId: string) => `/u/${encodeURIComponent(username)}?shop=1&product=${encodeURIComponent(productId)}`,
};

/** Only tiny inline previews the API sends for locked posts; never a remote URL. */
const isInlinePreview = (s: string | null | undefined): s is string => !!s && /^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(s);

/**
 * A post for subscribers, seen by someone who isn't one: a blurred preview, who it's from, what
 * it holds, and a way to subscribe. Subscribing is paid on the web; the plans and their perks can
 * be read here first.
 */
export function LockedPanel({ post, dark }: { post: Post; dark?: boolean }) {
  const c = useColors();
  const { t, tp } = useT();
  const preview = post.locked?.placeholder;
  const blurred = isInlinePreview(preview);
  const fg = dark || blurred ? '#FFFFFF' : c.ink;
  const muted = dark || blurred ? '#E6E8F2' : c.inkMuted;
  const media = post.locked?.mediaCount ?? 0;
  return (
    <View
      style={{
        borderRadius: dark ? 0 : radius.md,
        overflow: 'hidden',
        backgroundColor: dark ? '#10121E' : c.surfaceSunken,
        minHeight: blurred ? 240 : undefined,
        justifyContent: 'center',
        flex: dark ? 1 : undefined,
      }}
    >
      {blurred ? (
        <Image
          source={{ uri: preview }}
          blurRadius={20}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
        />
      ) : null}
      {blurred ? <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: dark ? '#00000080' : '#00000059' }} /> : null}
      <View style={{ alignItems: 'center', gap: space[2], padding: space[6] }}>
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: radius.full,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: dark || blurred ? '#FFFFFF26' : c.surface,
          }}
        >
          <Icon name="lock-closed" size={22} color={fg} />
        </View>
        <Text accessibilityRole="header" style={{ color: fg, fontWeight: '800', fontSize: 17 }}>
          {t('post.locked.title')}
        </Text>
        <Text style={[{ color: muted, textAlign: 'center', lineHeight: 20 }, userText]}>{t('post.locked.body', { name: post.author.displayName })}</Text>
        {media ? <Text style={{ color: muted, fontSize: 13 }}>{tp('m.money.lockedMedia', media)}</Text> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: space[2], marginTop: space[1] }}>
          <Button label={t('m.money.subscribeOnWeb')} size="sm" icon="open-outline" onPress={() => openOnWeb(webCheckout.subscribe(post.author.username))} />
          <Button
            label={t('m.money.seePlans')}
            size="sm"
            variant="secondary"
            onPress={() => router.push({ pathname: '/plans', params: { username: post.author.username } })}
          />
        </View>
        <Text style={{ color: muted, fontSize: 12, textAlign: 'center' }}>{t('m.shop.onWeb')}</Text>
      </View>
    </View>
  );
}

/** "Digital download", "Service" or "Product" for a shop item. */
export function useKindLabel() {
  const { t } = useT();
  return (kind: ShopItem['kind']) =>
    kind === 'digital' ? t('m.shop.digital') : kind === 'service' ? t('m.shop.service') : kind === 'booking' ? t('shop.kind.booking') : t('shop.kind.product');
}

/**
 * A profile's Shop tab: what they sell. Each item opens its own screen, where downloads you
 * bought open and buying or booking goes to checkout on the web.
 */
export function ShopList({ userId, username, isSelf }: { userId: string; username: string; isSelf: boolean }) {
  const c = useColors();
  const { t, locale } = useT();
  const kindLabel = useKindLabel();
  const commerce = useFlag('COMMERCE');
  const [items, setItems] = useState<ShopItem[] | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        setItems((await (await client()).shop.list(userId)).items);
      } catch {
        setItems([]);
      }
    })();
  }, [userId]);

  if (commerce === false) return <EmptyState title={t('m.shop.tab')} body={t('shop.unavailable')} />;
  if (items === null) return <Loading />;
  if (!items.length) return <EmptyState title={t('m.shop.empty')} body={isSelf ? t('shop.emptySelf') : undefined} />;
  return (
    <View style={{ gap: space[3] }}>
      {items.map((p) => {
        const price = formatMoney(p.priceCents, p.currency, locale);
        const state = p.owned ? t('m.product.owned') : p.inventory === 0 ? t('shop.soldOut') : null;
        return (
          <Card
            key={p.id}
            onPress={() => router.push({ pathname: '/product', params: { username, id: p.id } })}
            label={[p.title, kindLabel(p.kind), price, state].filter(Boolean).join(', ')}
            style={{ gap: space[2] }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space[3] }}>
              <View style={{ width: 44, height: 44, borderRadius: radius.md, backgroundColor: c.yapiSoft, alignItems: 'center', justifyContent: 'center' }}>
                <Icon
                  name={p.kind === 'digital' ? 'download-outline' : p.kind === 'service' ? 'calendar-outline' : 'bag-handle-outline'}
                  size={22}
                  color={c.yapi}
                />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[{ color: c.ink, fontWeight: '700', fontSize: 16 }, userText]} numberOfLines={2}>
                  {p.title}
                </Text>
                <Text style={{ color: c.inkMuted, fontSize: 12, fontWeight: '600' }}>
                  {kindLabel(p.kind)}
                  {p.file ? ` · ${formatBytes(p.file.sizeBytes)}` : ''}
                </Text>
              </View>
              <Icon name="chevron-forward" size={18} color={c.inkMuted} directional />
            </View>
            {p.description ? (
              <Text style={[{ color: c.inkMuted, fontSize: 14, lineHeight: 20 }, userText]} numberOfLines={3}>
                {p.description}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Text style={{ color: c.ink, fontWeight: '800', fontSize: 15 }}>{price}</Text>
              {state ? <Text style={{ color: p.owned ? c.success : c.inkMuted, fontSize: 13, fontWeight: '600' }}>{state}</Text> : null}
            </View>
          </Card>
        );
      })}
      {isSelf ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18, textAlign: 'center' }}>{t('m.product.yours')}</Text> : null}
    </View>
  );
}

type PlansData = Awaited<ReturnType<Awaited<ReturnType<typeof client>>['economy']['plans']>>;

/** A creator's plans and whether you're subscribed, loaded again after checkout on the web. */
export function usePlans(userId: string | undefined) {
  const [data, setData] = useState<PlansData | null | undefined>(undefined);
  const load = useCallback(async () => {
    if (!userId) return;
    try {
      setData(await (await client()).economy.plans(userId));
    } catch {
      setData(null);
    }
  }, [userId]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, load };
}

/** Each plan with its price and perks (what the creator wrote about it), and yours marked. */
export function PlanList({ plans, mine }: { plans: PlansData['items']; mine: PlansData['mySubscription'] }) {
  const c = useColors();
  const { t, locale } = useT();
  return (
    <View style={{ gap: space[2] }}>
      {plans.map((p) => {
        const yours = mine?.plan_id === p.id;
        const status = yours ? (mine!.status === 'active' ? t('m.money.subscribed') : t('m.money.waitingPayment')) : null;
        const price = t('m.money.perMonth', { price: formatMoney(p.priceCents, p.currency, locale) });
        return (
          <View
            key={p.id}
            accessible
            accessibilityLabel={[p.name, price, p.description, status].filter(Boolean).join(', ')}
            style={{
              borderRadius: radius.md,
              borderWidth: yours ? 2 : 1,
              borderColor: yours ? c.yapi : c.line,
              padding: space[3],
              gap: space[1],
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Text style={[{ color: c.ink, fontWeight: '800', fontSize: 15, flex: 1 }, userText]}>{p.name}</Text>
              {status ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Icon name={mine!.status === 'active' ? 'checkmark-circle' : 'time-outline'} size={16} color={c.yapi} />
                  <Text style={{ color: c.yapi, fontSize: 13, fontWeight: '700' }}>{status}</Text>
                </View>
              ) : null}
            </View>
            <Text style={{ color: c.ink, fontWeight: '700' }}>{price}</Text>
            {p.description ? <Text style={[{ color: c.inkMuted, lineHeight: 20 }, userText]}>{p.description}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * On someone else's profile: their plans (with perks) and a tip. Shown when they have a plan or
 * are a creator. Subscribing and tipping open checkout on the web.
 */
export function SupportCard({ userId, username, name, isCreator }: { userId: string; username: string; name: string; isCreator: boolean }) {
  const c = useColors();
  const { t } = useT();
  const commerce = useFlag('COMMERCE');
  const { data, load } = usePlans(userId);
  const { open, opened } = useWebCheckout(() => void load());
  if (commerce === false || !data || (!data.items.length && !isCreator)) return null;
  const sub = data.mySubscription;
  return (
    <Card style={{ gap: space[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
        <Icon name="heart-circle-outline" size={22} color={c.yapi} />
        <Text accessibilityRole="header" style={[{ color: c.ink, fontWeight: '800', fontSize: 17, flex: 1 }, userText]}>
          {t('m.money.supportTitle', { name })}
        </Text>
      </View>
      {data.items.length ? <PlanList plans={data.items} mine={sub} /> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
        {data.items.length && !sub ? (
          <Button label={t('m.money.subscribeOnWeb')} size="sm" icon="open-outline" onPress={() => open(webCheckout.subscribe(username))} />
        ) : null}
        <Button label={t('m.money.tip')} size="sm" variant="secondary" icon="cash-outline" onPress={() => open(webCheckout.tip(username))} />
      </View>
      <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 12, lineHeight: 17 }}>
        {opened ? t('m.money.afterSubscribing') : `${t('m.money.fee')} ${t('m.shop.onWeb')}`}
      </Text>
    </Card>
  );
}

/** The small tip button on a creator's post: a tip for this post, paid on the web. */
export function TipButton({ post }: { post: Post }) {
  const c = useColors();
  const { t } = useT();
  const commerce = useFlag('COMMERCE');
  if (commerce === false) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('m.money.tipPost', { name: post.author.displayName })}
      accessibilityHint={t('m.shop.onWeb')}
      hitSlop={8}
      onPress={() => void openOnWeb(webCheckout.tip(post.author.username, post.id))}
      style={({ pressed }) => ({ minHeight: 32, justifyContent: 'center', opacity: pressed ? 0.7 : 1 })}
    >
      <Icon name="cash-outline" size={20} color={c.inkMuted} />
    </Pressable>
  );
}

/** Start a digital download: a fresh link that works for 10 minutes, opened by the system. */
export async function openDownload(productId: string) {
  const { url } = await (await client()).shop.download(productId);
  await Linking.openURL(url);
}
