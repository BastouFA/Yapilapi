import { getLocales } from 'expo-localization';
import { useEffect, useState } from 'react';
import { Platform, Text, View } from 'react-native';
import { digitalPurchaseOffer, type ClientPlatform } from '../../../packages/shared/src/store-purchases';
import { cachedStorePolicy, loadStorePolicy } from './flags';
import { useSession } from './session';
import { space } from './theme';
import { Icon, useColors } from './ui';

/**
 * App store rules for digital goods in the phone app (docs/operations/in-app-purchases.md and
 * packages/shared/src/store-purchases.ts). Digital goods are Plus, subscriptions to creators,
 * tips and gifts, boosts, downloads and tickets to lives. Physical goods, services and tickets to
 * events in a real place keep their web checkout whatever the setting says.
 */

/**
 * The seam for the store's own purchase sheet (StoreKit 2 on iPhone), for IOS_DIGITAL_PURCHASES=iap.
 *
 * TODO(iap): no native module exists yet and nothing is installed for it. Adding one means a
 * development build with a StoreKit module (Expo config plugin or a small local module), products
 * set up in App Store Connect, and an API route that verifies the signed transaction with Apple's
 * App Store Server API before granting Plus or anything else. Until then `storeBilling` is null,
 * and the iap setting behaves like hidden. The steps are in docs/operations/in-app-purchases.md.
 */
export interface StoreBilling {
  /**
   * The App Store country of the signed-in Apple account (Storefront.current). StoreKit gives a
   * three-letter code; the module must return the two-letter ISO 3166 code.
   */
  storefrontCountry(): Promise<string | null>;
  /** The store's products with prices in the buyer's currency, as the store formats them. */
  products(ids: string[]): Promise<{ id: string; displayPrice: string }[]>;
  /**
   * Show the store's purchase sheet. `appAccountToken` ties the purchase to this account; the
   * signed transaction goes to the API, which verifies it before granting anything.
   */
  purchase(productId: string, o: { appAccountToken: string }): Promise<{ signedTransaction: string } | { cancelled: true }>;
  /** Restore purchases (App Review expects a way to do this for subscriptions). */
  restore(): Promise<string[]>;
}

/** No store module in this build. */
export const storeBilling: StoreBilling | null = null;

const platform: ClientPlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'mobile';

/**
 * How this phone may offer digital goods: `link` (a button to the web checkout), `store` (the
 * store's purchase sheet) or `hidden` (no button and no price, only a plain line). Undefined
 * while the setting is loading; treat that like hidden so nothing appears and then vanishes.
 */
export type DigitalOffer = 'link' | 'store' | 'hidden';

export function useDigitalPurchases(): DigitalOffer | undefined {
  const { me } = useSession();
  const country = me?.country ?? null;
  const [storefront, setStorefront] = useState<string | null>(null);
  const [offer, setOffer] = useState<DigitalOffer | undefined>(() => {
    const p = cachedStorePolicy();
    return p ? toOffer(digitalPurchaseOffer(p, platform, { countries: [deviceRegion(), country], storeAvailable: !!storeBilling })) : undefined;
  });
  useEffect(() => {
    if (!storeBilling) return;
    let live = true;
    storeBilling.storefrontCountry().then(
      (c) => live && setStorefront(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    let live = true;
    loadStorePolicy().then(
      (p) => {
        // The storefront, the phone's region and the account's country must all be allowed.
        const countries = [storefront, deviceRegion(), country];
        if (live) setOffer(toOffer(digitalPurchaseOffer(p, platform, { countries, storeAvailable: !!storeBilling })));
      },
      () => live && setOffer((cur) => cur ?? 'hidden'),
    );
    return () => {
      live = false;
    };
  }, [country, storefront]);
  return offer;
}

const toOffer = (o: ReturnType<typeof digitalPurchaseOffer>): DigitalOffer => (o === 'checkout' ? 'link' : o);

function deviceRegion(): string | null {
  try {
    return getLocales().find((l) => l.regionCode)?.regionCode ?? null;
  } catch {
    return null;
  }
}

/**
 * The plain line shown instead of a buy button when digital goods are hidden: no link, no price,
 * nothing to tap (the reader-app pattern App Review accepts).
 */
export function ManagedOnWeb({ text }: { text: string }) {
  const c = useColors();
  return (
    <View accessible style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space[2] }}>
      <Icon name="information-circle-outline" size={18} color={c.inkMuted} />
      <Text style={{ color: c.inkMuted, fontSize: 13, lineHeight: 18, flex: 1 }}>{text}</Text>
    </View>
  );
}
