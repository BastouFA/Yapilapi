import { describe, expect, it } from 'vitest';
import {
  clientPlatformFrom,
  DEFAULT_STORE_PURCHASE_POLICY,
  digitalPurchaseOffer,
  isDigitalPurchase,
  linkAllowedIn,
  mayStartDigitalCheckout,
  parseCountryList,
  type StorePurchasePolicy,
} from './store-purchases.ts';

const policy = (ios: StorePurchasePolicy['ios']['mode'], android: StorePurchasePolicy['android']['mode'], countries = ['US']): StorePurchasePolicy => ({
  ios: { mode: ios, linkCountries: countries },
  android: { mode: android, linkCountries: countries },
});

describe('store purchase policy', () => {
  it('hides digital purchases on phones by default and keeps the web checkout', () => {
    const p = DEFAULT_STORE_PURCHASE_POLICY;
    expect(digitalPurchaseOffer(p, 'web')).toBe('checkout');
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['US'] })).toBe('hidden');
    expect(digitalPurchaseOffer(p, 'android', { countries: ['US'] })).toBe('hidden');
    expect(mayStartDigitalCheckout(p, 'web')).toBe(true);
    expect(mayStartDigitalCheckout(p, 'ios')).toBe(false);
    expect(mayStartDigitalCheckout(p, 'android')).toBe(false);
    expect(mayStartDigitalCheckout(p, 'mobile')).toBe(false);
  });

  it('links out only in the listed countries', () => {
    const p = policy('external_link', 'user_choice');
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['US'] })).toBe('link');
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['NG'] })).toBe('hidden');
    expect(digitalPurchaseOffer(p, 'android', { countries: ['us'] })).toBe('link');
    // Every known country must be listed; knowing none is a no.
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['US', 'FR'] })).toBe('hidden');
    expect(digitalPurchaseOffer(p, 'ios', { countries: [null, undefined, ''] })).toBe('hidden');
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['US', null] })).toBe('link');
    expect(mayStartDigitalCheckout(p, 'ios')).toBe(true);
    expect(mayStartDigitalCheckout(p, 'android')).toBe(true);
  });

  it('uses the store only when the app has a store module', () => {
    const p = policy('iap', 'play_billing_required');
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['US'] })).toBe('hidden');
    expect(digitalPurchaseOffer(p, 'ios', { countries: ['US'], storeAvailable: true })).toBe('store');
    // The card checkout is never started from the phone when the store takes the payment.
    expect(mayStartDigitalCheckout(p, 'ios')).toBe(false);
  });

  it('treats a phone that did not say which by the stricter setting', () => {
    expect(digitalPurchaseOffer(policy('external_link', 'play_billing_required'), 'mobile', { countries: ['US'] })).toBe('hidden');
    expect(digitalPurchaseOffer(policy('external_link', 'user_choice'), 'mobile', { countries: ['US'] })).toBe('link');
    expect(mayStartDigitalCheckout(policy('external_link', 'play_billing_required'), 'mobile')).toBe(false);
  });

  it('reads the platform header and country lists', () => {
    expect(clientPlatformFrom('ios')).toBe('ios');
    expect(clientPlatformFrom(' Android ')).toBe('android');
    expect(clientPlatformFrom('mobile')).toBe('mobile');
    expect(clientPlatformFrom(undefined)).toBe('web');
    expect(clientPlatformFrom('windows')).toBe('web');
    expect(parseCountryList('us, gb;FR  x USA')).toEqual(['US', 'GB', 'FR']);
    expect(parseCountryList('')).toEqual([]);
    expect(linkAllowedIn([], ['US'])).toBe(false);
  });

  it('knows what the stores count as digital', () => {
    for (const k of ['plus', 'creator_subscription', 'tip', 'boost', 'ad_budget', 'digital_download', 'live_ticket'] as const)
      expect(isDigitalPurchase(k)).toBe(true);
    for (const k of ['physical_product', 'service_booking', 'event_ticket'] as const) expect(isDigitalPurchase(k)).toBe(false);
  });
});
