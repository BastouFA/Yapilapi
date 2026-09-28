import type { FastifyRequest } from 'fastify';
import { clientPlatformFrom, mayStartDigitalCheckout, type PurchaseKind, type StorePurchasePolicy } from '@yapilapi/shared';
import type { Config } from '../config.ts';
import { AppError } from './errors.ts';

/**
 * App store rules for digital goods bought in the phone apps (packages/shared/src/store-purchases.ts
 * and docs/operations/in-app-purchases.md). The settings live in the API's configuration, so they
 * change without a new app release; the phone reads them from /v1/flags.
 */
export function storePurchasePolicy(config: Config): StorePurchasePolicy {
  return {
    ios: { mode: config.IOS_DIGITAL_PURCHASES, linkCountries: config.IOS_EXTERNAL_LINK_COUNTRIES },
    android: { mode: config.ANDROID_DIGITAL_PURCHASES, linkCountries: config.ANDROID_USER_CHOICE_COUNTRIES },
  };
}

/**
 * Refuses to start a card checkout for a digital purchase from a phone app that isn't allowed to
 * sell it (the `x-client-platform` header the app sends). A purchase made on the web goes ahead.
 * Physical goods and real-world services never come here.
 */
export function assertDigitalCheckoutAllowed(req: FastifyRequest, config: Config, kind: PurchaseKind) {
  const platform = clientPlatformFrom(req.headers['x-client-platform']);
  if (mayStartDigitalCheckout(storePurchasePolicy(config), platform)) return;
  throw new AppError(403, 'store_purchase_required', "This can't be bought in the phone app. You can manage it on the web.", { kind, platform });
}
