/**
 * App store rules for paying inside the phone app (docs/operations/in-app-purchases.md).
 *
 * Apple and Google want digital goods bought inside their apps (Plus, subscriptions to creators,
 * tips, boosts, downloads, tickets to lives) paid through their own stores. Physical goods and
 * real-world services (a product posted to you, a booked haircut, a ticket to an event in a real
 * place) may use any checkout. How the phone app offers digital goods is a server setting, so the
 * owner can change it without a new app release:
 *
 * iPhone (IOS_DIGITAL_PURCHASES):
 * - hidden: no buy buttons or prices for digital goods, only a plain line such as "You can manage
 *   Plus on the web", without a link (the reader-app pattern). The default.
 * - external_link: a link out to the web checkout, only where the storefront country is listed in
 *   IOS_EXTERNAL_LINK_COUNTRIES (default US). Elsewhere it behaves like hidden.
 * - iap: Apple In-App Purchase through a native StoreKit module that doesn't exist yet. Until the
 *   app has one, it behaves like hidden.
 *
 * Android (ANDROID_DIGITAL_PURCHASES):
 * - play_billing_required: like hidden. The default.
 * - user_choice: a link out to the web checkout, only where the country is listed in
 *   ANDROID_USER_CHOICE_COUNTRIES (default US).
 *
 * The web app always has its checkout. Pure and free of zod: the phone imports this file.
 */

export const IOS_DIGITAL_PURCHASE_MODES = ['hidden', 'external_link', 'iap'] as const;
export type IosDigitalPurchases = (typeof IOS_DIGITAL_PURCHASE_MODES)[number];

export const ANDROID_DIGITAL_PURCHASE_MODES = ['play_billing_required', 'user_choice'] as const;
export type AndroidDigitalPurchases = (typeof ANDROID_DIGITAL_PURCHASE_MODES)[number];

/** What the API sends in /v1/flags as `purchases`. Countries are ISO 3166 codes in capitals. */
export interface StorePurchasePolicy {
  ios: { mode: IosDigitalPurchases; linkCountries: string[] };
  android: { mode: AndroidDigitalPurchases; linkCountries: string[] };
}

/** The safe answer when the setting can't be read: nothing digital is offered in the phone app. */
export const DEFAULT_STORE_PURCHASE_POLICY: StorePurchasePolicy = {
  ios: { mode: 'hidden', linkCountries: ['US'] },
  android: { mode: 'play_billing_required', linkCountries: ['US'] },
};

/**
 * Where a request comes from, from the `x-client-platform` header. The phone app sends `ios` or
 * `android`; older builds sent `mobile` only when signing in, which is a phone of either kind.
 */
export type ClientPlatform = 'web' | 'ios' | 'android' | 'mobile';

export function clientPlatformFrom(header: unknown): ClientPlatform {
  const v = typeof header === 'string' ? header.trim().toLowerCase() : '';
  return v === 'ios' || v === 'android' || v === 'mobile' ? v : 'web';
}

/** Every kind of thing people pay for, and whether the stores count it as digital. */
export const PURCHASE_KINDS = {
  plus: { digital: true },
  creator_subscription: { digital: true },
  tip: { digital: true },
  boost: { digital: true },
  ad_budget: { digital: true },
  digital_download: { digital: true },
  live_ticket: { digital: true },
  physical_product: { digital: false },
  service_booking: { digital: false },
  event_ticket: { digital: false },
} as const;
export type PurchaseKind = keyof typeof PURCHASE_KINDS;

export const isDigitalPurchase = (kind: PurchaseKind) => PURCHASE_KINDS[kind].digital;

/**
 * How the phone app offers a digital purchase:
 * - checkout: pay here (the web app);
 * - link: a button that opens the web checkout in the browser;
 * - store: the app store's own purchase sheet;
 * - hidden: no button and no price, only a plain line that it's managed on the web.
 */
export type DigitalPurchaseOffer = 'checkout' | 'link' | 'store' | 'hidden';

const upper = (c: string | null | undefined) => (c ? c.trim().toUpperCase() : '');

/**
 * Whether a link out is allowed for these countries: every country we know of (the store's
 * storefront, the phone's region, the account's country) must be listed, and at least one must be
 * known. When they disagree, the stricter answer wins.
 */
export function linkAllowedIn(listed: readonly string[], countries: readonly (string | null | undefined)[]): boolean {
  const known = countries.map(upper).filter((c) => /^[A-Z]{2}$/.test(c));
  const allowed = new Set(listed.map(upper));
  return known.length > 0 && known.every((c) => allowed.has(c));
}

export function digitalPurchaseOffer(
  policy: StorePurchasePolicy,
  platform: ClientPlatform,
  o: { countries?: readonly (string | null | undefined)[]; storeAvailable?: boolean } = {},
): DigitalPurchaseOffer {
  const countries = o.countries ?? [];
  if (platform === 'web') return 'checkout';
  if (platform === 'ios') {
    if (policy.ios.mode === 'external_link') return linkAllowedIn(policy.ios.linkCountries, countries) ? 'link' : 'hidden';
    if (policy.ios.mode === 'iap') return o.storeAvailable ? 'store' : 'hidden';
    return 'hidden';
  }
  if (platform === 'android') {
    if (policy.android.mode === 'user_choice') return linkAllowedIn(policy.android.linkCountries, countries) ? 'link' : 'hidden';
    return 'hidden';
  }
  // A phone that didn't say which: only what both allow.
  const ios = digitalPurchaseOffer(policy, 'ios', o);
  const android = digitalPurchaseOffer(policy, 'android', o);
  return ios === 'link' && android === 'link' ? 'link' : 'hidden';
}

/**
 * Whether the API may start a card checkout for a digital purchase from this client. The web
 * always may. The phone app never takes card payments itself for digital goods: in the link modes
 * it opens the web checkout in the browser, whose requests come from the web. So a phone request
 * is refused whenever its platform's setting hides digital purchases or expects the store's own
 * purchase sheet.
 */
export function mayStartDigitalCheckout(policy: StorePurchasePolicy, platform: ClientPlatform): boolean {
  if (platform === 'web') return true;
  const ios = policy.ios.mode === 'external_link';
  const android = policy.android.mode === 'user_choice';
  if (platform === 'ios') return ios;
  if (platform === 'android') return android;
  return ios && android;
}

/** Reads a list of countries from a setting like "US, GB". Anything that isn't two letters is left out. */
export function parseCountryList(value: string | null | undefined): string[] {
  return [
    ...new Set(
      (value ?? '')
        .split(/[\s,;]+/)
        .map(upper)
        .filter((c) => /^[A-Z]{2}$/.test(c)),
    ),
  ];
}
