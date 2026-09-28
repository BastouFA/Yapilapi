import { useEffect, useState } from 'react';
import { DEFAULT_STORE_PURCHASE_POLICY, type StorePurchasePolicy } from '../../../packages/shared/src/store-purchases';
import { client } from './api';
import { useSession } from './session';

type Flags = Record<string, boolean>;

/** How long an answer is used before asking again. */
const FRESH_MS = 60_000;

let cached: Flags | null = null;
let cachedPurchases: StorePurchasePolicy | null = null;
let fetchedAt = 0;
let pending: Promise<Flags> | null = null;

/** The feature flags from /v1/flags, shared by every screen and asked for again after a minute. */
export function loadFlags(): Promise<Flags> {
  if (cached && Date.now() - fetchedAt < FRESH_MS) return Promise.resolve(cached);
  if (pending) return pending;
  pending = client()
    .then((api) => api.flags())
    .then((r) => {
      cached = r.flags;
      // An older server doesn't send it: nothing digital is offered then.
      cachedPurchases = r.purchases ?? DEFAULT_STORE_PURCHASE_POLICY;
      fetchedAt = Date.now();
      return r.flags;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

/** How the app store rules say this app may offer digital goods, from the same answer as the flags. */
export async function loadStorePolicy(): Promise<StorePurchasePolicy> {
  await loadFlags();
  return cachedPurchases ?? DEFAULT_STORE_PURCHASE_POLICY;
}

/** The last known store policy, if any, to show straight away. */
export const cachedStorePolicy = () => cachedPurchases;

/**
 * Whether a feature is turned on: undefined while it's being checked, then true or false. The
 * last answer shows straight away, and is checked again when it is more than a minute old.
 */
export function useFlag(name: string): boolean | undefined {
  const signedIn = !!useSession().me;
  const [on, setOn] = useState<boolean | undefined>(cached ? !!cached[name] : undefined);
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    loadFlags().then(
      (f) => live && setOn(!!f[name]),
      () => live && setOn((cur) => cur ?? false),
    );
    return () => {
      live = false;
    };
  }, [name, signedIn]);
  return on;
}
