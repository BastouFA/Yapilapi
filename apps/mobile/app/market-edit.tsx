import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, Image, Linking, Pressable, ScrollView, Text, View } from 'react-native';
import { ApiError } from '../../../packages/api-client/src/index';
import type { LatLng } from '../../../packages/shared/src/location';
import {
  MARKET_AREA_MAX,
  MARKET_CATEGORIES,
  MARKET_CONDITIONS,
  MARKET_DELIVERY,
  MARKET_DESCRIPTION_MAX,
  MARKET_MAX_PHOTOS,
  MARKET_PHOTO_ALT_MAX,
  MARKET_PROHIBITED,
  MARKET_TITLE_MAX,
  prohibitedMatch,
  type MarketCategory,
  type MarketCondition,
  type MarketDelivery,
  type MarketListing,
  type MarketProhibited,
} from '../../../packages/shared/src/market';
import { client, errorMessage, isGone, mediaUrl } from '../lib/api';
import { Chip, ChipRow } from '../lib/chips';
import { ChoiceField, FieldError, useScrollToError } from '../lib/forms';
import { useT } from '../lib/i18n';
import {
  CATEGORY_KEYS,
  CONDITION_KEYS,
  DELIVERY_KEYS,
  marketGeolocation,
  parseAmount,
  placeProblem,
  PROHIBITED_KEYS,
  readApproximatePlace,
  SellBlockNote,
  useMarketMe,
} from '../lib/market';
import { pickOne, uploadPicked } from '../lib/media';
import { radius, space } from '../lib/theme';
import { Button, Field, Icon, Loading, Notice, ScreenError, SwitchRow, useColors } from '../lib/ui';
import { noticeText } from '../../../packages/shared/src/server-text';

type Photo = { key: string; uri: string; mediaId: string | null; alt: string; progress: number | null; failed: boolean };
/** A place: unchanged (editing), a new approximate one, or taken off. */
type PlaceState = { kind: 'keep' } | { kind: 'set'; point: LatLng } | { kind: 'none' };

/**
 * Sell something, or change a listing of yours (`?id=`): up to ten photos from the library (each
 * with a description for screen readers), title, price or Free, condition, category, description,
 * the pickup area in words, how it can change hands, and (only where this build can read a
 * position) an approximate place. Words that look like something Market doesn't allow are caught
 * before sending; the seller can say it isn't, and then it waits for a moderator.
 */
export default function MarketEdit() {
  const params = useLocalSearchParams<{ id?: string }>();
  const editing = params.id ?? null;
  const c = useColors();
  const { t, tp } = useT();
  const { me } = useMarketMe();
  const [loaded, setLoaded] = useState<MarketListing | null | undefined>(editing ? undefined : null);
  // Why the listing couldn't load, when that isn't because it's gone or not yours.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [free, setFree] = useState(false);
  const [condition, setCondition] = useState<MarketCondition>('good');
  const [category, setCategory] = useState<MarketCategory | null>(null);
  const [description, setDescription] = useState('');
  const [area, setArea] = useState('');
  const [delivery, setDelivery] = useState<MarketDelivery[]>(['pickup']);
  const [place, setPlace] = useState<PlaceState>({ kind: 'none' });
  const [locating, setLocating] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<'adults_only' | 'birth_date_required' | null>(null);
  // The prohibited-items check: what it looked like (null when unknown), shown until changed or confirmed.
  const [prohibited, setProhibited] = useState<{ kind: MarketProhibited | null } | null>(null);
  const [photoDenied, setPhotoDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const keys = useRef(0);
  const form = useScrollToError();
  const canPlace = !!marketGeolocation();

  // Changing a listing: start from what it says now.
  const loadListing = useCallback(() => {
    if (!editing) return;
    setLoadError(null);
    void client()
      .then((api) => api.market.get(editing))
      .then(
        ({ listing }) => {
          setPhotos(
            listing.photos.map((p) => ({
              key: p.mediaId,
              uri: mediaUrl(p.thumbUrl || p.url),
              mediaId: p.mediaId,
              alt: p.altText ?? '',
              progress: null,
              failed: false,
            })),
          );
          setTitle(listing.title);
          setFree(listing.priceCents === null);
          setPrice(listing.priceCents === null ? '' : String(listing.priceCents / 100));
          setCondition(listing.condition);
          setCategory(listing.category);
          setDescription(listing.description);
          setArea(listing.where.area);
          setDelivery(listing.delivery);
          setPlace(listing.hasPlace ? { kind: 'keep' } : { kind: 'none' });
          setLoaded(listing);
        },
        (e) => (isGone(e) ? setLoaded(null) : setLoadError(errorMessage(e))),
      );
  }, [editing]);
  useEffect(() => {
    loadListing();
  }, [loadListing]);

  const currency = loaded?.currency ?? me?.currency ?? '';
  const sellBlock = blocked ?? (me && !me.canSell && !editing ? me.sellBlock : null);

  // A change to the words asks the check again.
  useEffect(() => {
    setProhibited(null);
  }, [title, description]);

  async function addPhoto() {
    setPhotoDenied(false);
    const picked = await pickOne(['images']);
    if (picked === 'denied') return setPhotoDenied(true);
    if (!picked) return;
    const key = `new-${keys.current++}`;
    setPhotos((cur) => [...cur, { key, uri: picked.uri, mediaId: null, alt: '', progress: 0, failed: false }]);
    try {
      const up = await uploadPicked(picked, (f) => setPhotos((cur) => cur.map((p) => (p.key === key ? { ...p, progress: f } : p))));
      setPhotos((cur) => cur.map((p) => (p.key === key ? { ...p, mediaId: up.id, progress: null } : p)));
    } catch (e) {
      setPhotos((cur) => cur.map((p) => (p.key === key ? { ...p, failed: true, progress: null } : p)));
      setError(errorMessage(e));
    }
  }

  async function locate() {
    setLocating(true);
    try {
      setPlace({ kind: 'set', point: await readApproximatePlace() });
      AccessibilityInfo.announceForAccessibility(t('m.market.form.placeAdded'));
    } catch (e) {
      setFields((f) => ({ ...f, place: placeProblem(t, e) }));
    } finally {
      setLocating(false);
    }
  }

  function check(): Record<string, string> {
    const f: Record<string, string> = {};
    if (!photos.some((p) => p.mediaId)) f.photos = t('m.market.form.needPhoto');
    else if (photos.some((p) => !p.mediaId && !p.failed)) f.photos = t('m.market.form.waitPhotos');
    if (title.trim().length < 3) f.title = t('m.market.form.needTitle');
    if (!free && parseAmount(price) === null) f.price = t('m.market.form.needPrice');
    if (!category) f.category = t('m.market.form.needCategory');
    if (area.trim().length < 2) f.area = t('m.market.form.needArea');
    if (!delivery.length) f.delivery = t('m.market.form.needDelivery');
    return f;
  }

  async function submit(notProhibited = false) {
    const f = check();
    setFields(f);
    setError(null);
    if (Object.keys(f).length) {
      form.toFirst(f);
      AccessibilityInfo.announceForAccessibility(Object.values(f)[0]!);
      return;
    }
    // Caught before sending: the same check the API runs.
    if (!notProhibited) {
      const kind = prohibitedMatch(title, description);
      if (kind) {
        setProhibited({ kind });
        AccessibilityInfo.announceForAccessibility(t('m.market.form.prohibitedWarn', { kind: t(PROHIBITED_KEYS[kind]) }));
        return;
      }
    }
    setBusy(true);
    try {
      const api = await client();
      const body = {
        title: title.trim(),
        description: description.trim(),
        category: category!,
        condition,
        priceCents: free ? null : parseAmount(price),
        photos: photos.filter((p) => p.mediaId).map((p) => ({ mediaId: p.mediaId!, altText: p.alt.trim() || undefined })),
        area: area.trim(),
        delivery,
        ...(notProhibited ? { notProhibited: true } : {}),
      };
      const placeBody = place.kind === 'set' ? { place: place.point } : place.kind === 'none' && loaded?.hasPlace ? { place: null } : {};
      const r = editing ? await api.market.update(editing, { ...body, ...placeBody }) : await api.market.create({ ...body, ...placeBody });
      // Held for a quick look: say so where everyone sees it, not only to screen readers.
      const held = noticeText({ code: r.noticeCode, message: r.notice }, t);
      if (held) Alert.alert(held);
      router.replace(`/market/${r.listing.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'prohibited_item') {
        // The API names the kind in the error's details; the check here is the fallback.
        const named = e.details?.kind;
        const kind = MARKET_PROHIBITED.find((k) => k === named) ?? prohibitedMatch(title, description);
        setProhibited({ kind });
      } else if (e instanceof ApiError && e.code === 'adults_only') setBlocked('adults_only');
      else if (e instanceof ApiError && e.code === 'birth_date_required') setBlocked('birth_date_required');
      else if (e instanceof ApiError && e.code === 'market_daily_limit') setError(t('m.market.form.dailyLimit'));
      else if (e instanceof ApiError && e.fields && Object.keys(e.fields).length) {
        setFields(e.fields);
        form.toFirst(e.fields);
      } else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (loaded === undefined) return loadError ? <ScreenError message={loadError} onRetry={loadListing} /> : <Loading />;
  if (editing && loaded === null)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4] }}>
        <Notice tone="danger">{t('m.market.missing')}</Notice>
      </View>
    );

  if (sellBlock)
    return (
      <View style={{ flex: 1, backgroundColor: c.ground, padding: space[4], gap: space[3] }}>
        <Stack.Screen options={{ title: t('m.market.sell') }} />
        <SellBlockNote block={sellBlock} />
        {sellBlock === 'birth_date_required' ? (
          <Button label={t('m.market.openSettings')} variant="secondary" onPress={() => router.push('/settings')} />
        ) : null}
      </View>
    );

  const full = photos.length >= MARKET_MAX_PHOTOS;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        ref={form.ref}
        style={{ backgroundColor: c.ground }}
        contentContainerStyle={{ padding: space[4], gap: space[4], paddingBottom: space[8] }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        <Stack.Screen options={{ title: editing ? t('m.market.editTitle') : t('m.market.sell') }} />
        <Notice>{t('m.market.form.inPerson')}</Notice>
        {!editing && me && me.listingsLeftToday < 3 ? (
          <Text style={{ color: c.inkMuted, fontSize: 13 }}>{tp('m.market.leftToday', me.listingsLeftToday)}</Text>
        ) : null}

        <View onLayout={form.at('photos')} style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.market.photos')}</Text>
          <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.market.photosHint', { max: MARKET_MAX_PHOTOS })}</Text>
          {photos.map((p, i) => (
            <View key={p.key} style={{ flexDirection: 'row', gap: space[3], alignItems: 'flex-start' }}>
              <View style={{ width: 72, height: 72, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.surfaceSunken }}>
                <Image source={{ uri: p.uri }} style={{ width: 72, height: 72 }} accessibilityIgnoresInvertColors accessible={false} />
                {p.progress !== null || p.failed ? (
                  <View style={{ position: 'absolute', start: 0, end: 0, bottom: 0, backgroundColor: c.overlay, padding: 2 }}>
                    <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: '700', textAlign: 'center' }} accessibilityLiveRegion="polite">
                      {p.failed ? t('m.market.form.photoFailed') : `${Math.round((p.progress ?? 0) * 100)}%`}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={{ flex: 1 }}>
                <Field
                  label={i === 0 ? t('m.market.altLabelCover', { n: i + 1 }) : t('m.market.altLabel', { n: i + 1 })}
                  hint={t('m.market.altHint')}
                  value={p.alt}
                  onChangeText={(v) => setPhotos((cur) => cur.map((x) => (x.key === p.key ? { ...x, alt: v } : x)))}
                  maxLength={MARKET_PHOTO_ALT_MAX}
                  placeholder={title.trim() || undefined}
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('m.market.removePhoto', { n: i + 1 })}
                onPress={() => setPhotos((cur) => cur.filter((x) => x.key !== p.key))}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginTop: space[4] }}
              >
                <Icon name="close-circle" size={22} color={c.inkMuted} />
              </Pressable>
            </View>
          ))}
          {!full ? <Button label={t('m.market.addPhoto')} icon="image-outline" variant="secondary" onPress={addPhoto} /> : null}
          {photos.some((p) => p.progress !== null) ? (
            <Text accessibilityLiveRegion="polite" style={{ color: c.inkMuted, fontSize: 13 }}>
              {t('m.market.form.waitPhotos')}
            </Text>
          ) : null}
          {photoDenied ? (
            <Notice tone="warn">
              <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.market.photoDenied')}</Text>
              <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings()} hitSlop={8} style={{ minHeight: 44, justifyContent: 'center' }}>
                <Text style={{ color: c.yapi, fontWeight: '700' }}>{t('m.common.openSettings')}</Text>
              </Pressable>
            </Notice>
          ) : null}
          <FieldError text={fields.photos} />
        </View>

        <View onLayout={form.at('title')}>
          <Field label={t('m.market.form.title')} value={title} onChangeText={setTitle} maxLength={MARKET_TITLE_MAX} error={fields.title} />
        </View>

        <View onLayout={form.at('price')} style={{ gap: space[2] }}>
          <SwitchRow label={t('m.market.form.free')} value={free} onValueChange={setFree} />
          {!free ? (
            <Field
              label={currency ? t('m.market.form.price', { currency }) : t('m.market.form.pricePlain')}
              value={price}
              onChangeText={setPrice}
              keyboardType="decimal-pad"
              inputMode="decimal"
              maxLength={16}
              error={fields.price}
            />
          ) : null}
        </View>

        <ChoiceField<MarketCondition>
          label={t('m.market.form.condition')}
          value={condition}
          onChange={setCondition}
          options={MARKET_CONDITIONS.map((k) => ({ id: k, label: t(CONDITION_KEYS[k]) }))}
        />

        <View onLayout={form.at('category')} style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.market.form.category')}</Text>
          <ChipRow radios label={t('m.market.form.category')}>
            {MARKET_CATEGORIES.map((k) => (
              <Chip key={k} radio label={t(CATEGORY_KEYS[k])} selected={category === k} onPress={() => setCategory(k)} />
            ))}
          </ChipRow>
          <FieldError text={fields.category} />
        </View>

        <View onLayout={form.at('description')}>
          <Field
            label={t('m.market.form.description')}
            value={description}
            onChangeText={setDescription}
            maxLength={MARKET_DESCRIPTION_MAX}
            multiline
            style={{ minHeight: 110, paddingTop: space[2], textAlignVertical: 'top' }}
            error={fields.description}
          />
        </View>

        <View onLayout={form.at('area')}>
          <Field
            label={t('m.market.form.area')}
            hint={t('m.market.form.areaHint')}
            value={area}
            onChangeText={setArea}
            maxLength={MARKET_AREA_MAX}
            error={fields.area}
          />
        </View>

        <View onLayout={form.at('place')} style={{ gap: space[2] }}>
          {canPlace ? (
            place.kind === 'none' ? (
              <>
                <Button label={t('m.market.nearby.use')} icon="navigate-outline" variant="secondary" disabled={locating} onPress={locate} />
                <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.market.form.placeHint')}</Text>
              </>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
                <Icon name="checkmark-circle" size={18} color={c.success} />
                <Text style={{ color: c.ink, flex: 1 }}>{t('m.market.form.placeAdded')}</Text>
                <Button label={t('m.market.form.placeRemove')} size="sm" variant="ghost" onPress={() => setPlace({ kind: 'none' })} />
              </View>
            )
          ) : place.kind === 'keep' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}>
              <Icon name="checkmark-circle" size={18} color={c.success} />
              <Text style={{ color: c.ink, flex: 1 }}>{t('m.market.form.placeAdded')}</Text>
              <Button label={t('m.market.form.placeRemove')} size="sm" variant="ghost" onPress={() => setPlace({ kind: 'none' })} />
            </View>
          ) : (
            <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.market.form.placeNeedsUpdate')}</Text>
          )}
          <FieldError text={fields.place} />
        </View>

        <View onLayout={form.at('delivery')} style={{ gap: space[2] }}>
          <Text style={{ color: c.ink, fontWeight: '600', fontSize: 13 }}>{t('m.market.form.delivery')}</Text>
          <ChipRow label={t('m.market.form.delivery')}>
            {MARKET_DELIVERY.map((k) => {
              const on = delivery.includes(k);
              return (
                <Chip
                  key={k}
                  label={t(DELIVERY_KEYS[k])}
                  icon={on ? 'checkmark' : undefined}
                  selected={on}
                  onPress={() => setDelivery((cur) => (on ? cur.filter((x) => x !== k) : [...cur, k]))}
                />
              );
            })}
          </ChipRow>
          <FieldError text={fields.delivery} />
        </View>

        <View style={{ gap: space[2], padding: space[3], borderRadius: radius.md, backgroundColor: c.surfaceSunken }}>
          <Text accessibilityRole="header" style={{ color: c.ink, fontWeight: '800' }}>
            {t('m.market.form.prohibitedTitle')}
          </Text>
          <Text style={{ color: c.ink, lineHeight: 20 }}>{MARKET_PROHIBITED.map((k) => t(PROHIBITED_KEYS[k])).join(', ')}</Text>
        </View>

        {prohibited ? (
          <View accessibilityLiveRegion="polite" style={{ gap: space[2] }}>
            <Notice tone="warn" title={t('m.market.form.prohibitedCheck')}>
              <Text style={{ color: c.ink, lineHeight: 20 }}>
                {prohibited.kind ? t('m.market.form.prohibitedWarn', { kind: t(PROHIBITED_KEYS[prohibited.kind]) }) : t('m.market.form.prohibitedWarnPlain')}
              </Text>
              <Text style={{ color: c.ink, lineHeight: 20 }}>{t('m.market.form.notProhibitedHint')}</Text>
            </Notice>
            <Button label={t('m.market.form.notProhibited')} variant="secondary" disabled={busy} onPress={() => submit(true)} />
          </View>
        ) : null}

        {error ? <Notice tone="danger">{error}</Notice> : null}
        {Object.keys(fields).some((k) => k !== 'place') ? <FieldError text={t('m.common.fixAbove')} /> : null}
        {!prohibited ? (
          <Button label={busy ? t('m.common.saving') : editing ? t('common.save') : t('m.market.form.publish')} disabled={busy} onPress={() => submit(false)} />
        ) : null}
        {!editing ? <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18 }}>{t('m.market.form.reviewNote')}</Text> : null}
      </ScrollView>
    </View>
  );
}
